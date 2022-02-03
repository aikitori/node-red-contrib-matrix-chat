global.Olm = require('olm');
const fs = require("fs-extra");
const sdk = require("matrix-js-sdk");
const { LocalStorage } = require('node-localstorage');
const { LocalStorageCryptoStore } = require('matrix-js-sdk/lib/crypto/store/localStorage-crypto-store');

module.exports = function(RED) {
    function MatrixFolderNameFromUserId(name) {
        return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    }

    function MatrixServerNode(n) {
        let storageDir = './matrix-client-storage';

        RED.nodes.createNode(this, n);

        let node = this;
        node.log("Initializing Matrix Server Config node");

        if(!this.credentials) {
            this.credentials = {};
        }

        node.setMaxListeners(1000);

        this.connected = null;
        this.name = n.name;
        this.userId = this.credentials.userId;
        this.deviceLabel = this.credentials.deviceLabel || null;
        this.deviceId = this.credentials.deviceId || null;
        this.url = this.credentials.url;
        this.autoAcceptRoomInvites = n.autoAcceptRoomInvites;
        this.enableE2ee = n.enableE2ee || false;
        this.e2ee = (this.enableE2ee && this.deviceId);
        this.globalAccess = n.global;
        this.initializedAt = new Date();
        let localStorageDir = storageDir + '/' + MatrixFolderNameFromUserId(this.userId),
            localStorage = new LocalStorage(localStorageDir),
            initialSetup = false;

        let retryStartTimeout = null;

        if(!this.credentials.accessToken) {
            node.log("Matrix connection failed: missing access token.");
        } else if(!this.url) {
            node.log("Matrix connection failed: missing server URL.");
        } else if(!this.userId) {
            node.log("Matrix connection failed: missing user ID.");
        } else {
            node.setConnected = function(connected, cb) {
                if (node.connected !== connected) {
                    node.connected = connected;
                    if(typeof cb === 'function') {
                        cb(connected);
                    }

                    if (connected) {
                        node.log("Matrix server connection ready.");
                        node.emit("connected");
                        if(!initialSetup) {
                            // store Device ID internally
                            let stored_device_id = getStoredDeviceId(localStorage),
                                device_id = this.matrixClient.getDeviceId();
                            if(!stored_device_id || stored_device_id !== device_id) {
                                node.log(`Saving Device ID (old:${stored_device_id} new:${device_id})`);
                                storeDeviceId(localStorage, device_id);
                            }

                            // update device label
                            if(node.deviceLabel) {
                                node.matrixClient
                                    .getDevice(device_id)
                                    .then(
                                        function(response) {
                                            if(response.display_name !== node.deviceLabel) {
                                                node.matrixClient.setDeviceDetails(device_id, {
                                                    display_name: node.deviceLabel
                                                }).then(
                                                    function(response) {},
                                                    function(error) {
                                                        node.error("Failed to set device label: " + error);
                                                    }
                                                );
                                            }
                                        },
                                        function(error) {
                                            node.error("Failed to fetch device: " + error);
                                        }
                                    );
                            }

                            initialSetup = true;
                        }
                    } else {
                        node.emit("disconnected");
                    }

                    if(this.globalAccess) {
                        this.context().global.set('matrixClientOnline["'+this.userId+'"]', connected);
                    }
                }
            };
            node.setConnected(false);

            fs.ensureDirSync(storageDir); // create storage directory if it doesn't exist
            upgradeDirectoryIfNecessary(node, storageDir);
            node.matrixClient = sdk.createClient({
                baseUrl: this.url,
                accessToken: this.credentials.accessToken,
                sessionStore: new sdk.WebStorageSessionStore(localStorage),
                cryptoStore: new LocalStorageCryptoStore(localStorage),
                userId: this.userId,
                deviceId: (this.deviceId || getStoredDeviceId(localStorage)) || undefined
            });

            // set globally if configured to do so
            if(this.globalAccess) {
                this.context().global.set('matrixClient["'+this.userId+'"]', node.matrixClient);
            }

            function stopClient() {
                if(node.matrixClient && node.matrixClient.clientRunning) {
                    node.matrixClient.stopClient();
                    node.setConnected(false);
                }

                if(retryStartTimeout) {
                    clearTimeout(retryStartTimeout);
                }
            }

            node.on('close', function(done) {
                stopClient();
                done();
            });

            node.isConnected = function() {
                return node.connected;
            };

            node.matrixClient.on("Room.timeline", async function(event, room, toStartOfTimeline, removed, data) {
                if (toStartOfTimeline) {
                    return; // ignore paginated results
                }
                if (!event.getSender() || event.getSender() === node.userId) {
                    return; // ignore our own messages
                }
                if (!data || !data.liveEvent) {
                    return; // ignore old message (we only want live events)
                }
                if(node.initializedAt > event.getDate()) {
                    return; // skip events that occurred before our client initialized
                }

                try {
                    await node.matrixClient.decryptEventIfNeeded(event);
                } catch (error) {
                    node.error(error);
                    return;
                }

                let msg = {
                    encrypted : event.isEncrypted(),
                    redacted  : event.isRedacted(),
                    content   : event.getContent(),
                    type      : (event.getContent()['msgtype'] || event.getType()) || null,
                    payload   : (event.getContent()['body'] || event.getContent()) || null,
                    userId    : event.getSender(),
                    topic     : event.getRoomId(),
                    eventId   : event.getId(),
                    event     : event,
                };

                node.log("Received" + (msg.encrypted ? ' encrypted' : '') +" timeline event [" + msg.type + "]: (" + room.name + ") " + event.getSender() + " :: " + msg.content.body + (toStartOfTimeline ? ' [PAGINATED]' : ''));
                node.emit("Room.timeline", event, room, toStartOfTimeline, removed, data, msg);
            });

            /**
             * Fires when we want to suggest to the user that they restore their megolm keys
             * from backup or by cross-signing the device.
             *
             * @event module:client~MatrixClient#"crypto.suggestKeyRestore"
             */
            node.matrixClient.on("crypto.suggestKeyRestore", function(){

            });

            // node.matrixClient.on("RoomMember.typing", async function(event, member) {
            //     let isTyping = member.typing;
            //     let roomId = member.roomId;
            // });

            // node.matrixClient.on("RoomMember.powerLevel", async function(event, member) {
            //     let newPowerLevel = member.powerLevel;
            //     let newNormPowerLevel = member.powerLevelNorm;
            //     let roomId = member.roomId;
            // });

            // node.matrixClient.on("RoomMember.name", async function(event, member) {
            //     let newName = member.name;
            //     let roomId = member.roomId;
            // });

            // handle auto-joining rooms
            node.matrixClient.on("RoomMember.membership", async function(event, member) {
                if (member.membership === "invite" && member.userId === node.userId) {
                    if(node.autoAcceptRoomInvites) {
                        node.matrixClient.joinRoom(member.roomId).then(function() {
                            node.log("Automatically accepted invitation to join room " + member.roomId);
                        }).catch(function(e) {
                            node.warn("Cannot join room (could be from being kicked/banned) " + member.roomId + ": " + e);
                        });
                    } else {
                        node.log("Got invite to join room " + member.roomId);
                    }
                }
            });

            node.matrixClient.on("sync", async function(state, prevState, data) {
                node.debug("SYNC [STATE=" + state + "] [PREVSTATE=" + prevState + "]");
                if(prevState === null && state === "PREPARED" ) {
                    // Occurs when the initial sync is completed first time.
                    // This involves setting up filters and obtaining push rules.
                    node.setConnected(true, function(){
                        node.log("Matrix client connected");
                    });
                } else if(prevState === null && state === "ERROR") {
                    // Occurs when the initial sync failed first time.
                    node.setConnected(false, function(){
                        node.error("Failed to connect to Matrix server");
                    });
                } else if(prevState === "ERROR" && state === "PREPARED") {
                    // Occurs when the initial sync succeeds
                    // after previously failing.
                    node.setConnected(true, function(){
                        node.log("Matrix client connected");
                    });
                } else if(prevState === "PREPARED" && state === "SYNCING") {
                    // Occurs immediately after transitioning to PREPARED.
                    // Starts listening for live updates rather than catching up.
                    node.setConnected(true, function(){
                        node.log("Matrix client connected");
                    });
                } else if(prevState === "SYNCING" && state === "RECONNECTING") {
                    // Occurs when the live update fails.
                    node.setConnected(false, function(){
                        node.error("Connection to Matrix server lost");
                    });
                } else if(prevState === "RECONNECTING" && state === "RECONNECTING") {
                    // Can occur if the update calls continue to fail,
                    // but the keepalive calls (to /versions) succeed.
                    node.setConnected(false, function(){
                        node.error("Connection to Matrix server lost");
                    });
                } else if(prevState === "RECONNECTING" && state === "ERROR") {
                    // Occurs when the keepalive call also fails
                    node.setConnected(false, function(){
                        node.error("Connection to Matrix server lost");
                    });
                } else if(prevState === "ERROR" && state === "SYNCING") {
                    // Occurs when the client has performed a
                    // live update after having previously failed.
                    node.setConnected(true, function(){
                        node.log("Matrix client connected");
                    });
                } else if(prevState === "ERROR" && state === "ERROR") {
                    // Occurs when the client has failed to
                    // keepalive for a second time or more.
                    node.setConnected(false, function(){
                        node.error("Connection to Matrix server lost");
                    });
                } else if(prevState === "SYNCING" && state === "SYNCING") {
                    // Occurs when the client has performed a live update.
                    // This is called <i>after</i> processing.
                    node.setConnected(true, function(){
                        node.log("Matrix client connected");
                    });
                } else if(state === "STOPPED") {
                    // Occurs once the client has stopped syncing or
                    // trying to sync after stopClient has been called.
                    node.setConnected(false, function(){
                        node.error("Connection to Matrix server lost");
                    });
                }
            });

            node.matrixClient.on("Session.logged_out", async function(errorObj){
                // Example if user auth token incorrect:
                // {
                //     errcode: 'M_UNKNOWN_TOKEN',
                //     data: {
                //         errcode: 'M_UNKNOWN_TOKEN',
                //         error: 'Invalid macaroon passed.',
                //         soft_logout: false
                //     },
                //     httpStatus: 401
                // }

                console.log("Authentication failure: ", errorObj);
                node.error("Authentication failure: " + errorObj);
                stopClient();
            });

            async function run() {
                try {
                    if(node.e2ee){
                        node.log("Initializing crypto...");
                        await node.matrixClient.initCrypto();
                        node.matrixClient.setGlobalErrorOnUnknownDevices(false);
                    }
                    node.log("Connecting to Matrix server...");
                    await node.matrixClient.startClient({
                        initialSyncLimit: 8
                    });
                } catch(error) {
                    node.error(error);
                }
            }

            // do an authed request and only continue if we don't get an error
            // this prevent the matrix client from crashing Node-RED on invalid auth token
            (function checkAuthTokenThenStart() {
                if(node.matrixClient.clientRunning) {
                    return;
                }

                node.matrixClient.getAccountDataFromServer()
                    .then(
                        function() {
                            run().catch((error) => node.error(error));
                        },
                        function(err) {
                            // if the error isn't authentication related retry in a little bit
                            if(err.code !== "M_UNKNOWN_TOKEN") {
                                retryStartTimeout = setTimeout(checkAuthTokenThenStart, 15000);
                                node.error("Auth check failed: " + err);
                            }
                        }
                    )
            })();
        }
    }

    RED.nodes.registerType("matrix-server-config", MatrixServerNode, {
        credentials: {
            deviceLabel: { type: "text", required: false },
            userId: { type: "text", required: true },
            accessToken: { type: "text", required: true },
            deviceId: { type: "text", required: false },
            url: { type: "text", required: true }
        }
    });

    RED.httpAdmin.post(
        "/matrix-chat/login",
        RED.auth.needsPermission('flows.write'),
        function(req, res) {
            let userId = req.body.userId || undefined,
                password = req.body.password || undefined,
                baseUrl = req.body.baseUrl || undefined,
                deviceId = req.body.deviceId || undefined,
                displayName = req.body.displayName || undefined;

            const matrixClient = sdk.createClient({
                baseUrl: baseUrl,
                deviceId: deviceId,
                localTimeoutMs: '30000'
            });

            matrixClient.login(
                'm.login.password', {
                    user: userId,
                    password: password,
                    initial_device_display_name: displayName
                })
                .then(
                    function(response) {
                        res.json({
                            'result': 'ok',
                            'token': response.access_token,
                            'device_id': response.device_id,
                            'user_id': response.user_id,
                        });
                    },
                    function(err) {
                        res.json({
                            'result': 'error',
                            'message': err
                        });
                    }
                );
        });

    function upgradeDirectoryIfNecessary(node, storageDir) {
        let oldStorageDir = './matrix-local-storage';

        // if the old storage location exists lets move it to it's new location
        if(fs.pathExistsSync(oldStorageDir)){
            RED.nodes.eachNode(function(n){
                try {
                    if(n.type !== 'matrix-server-config') return;
                    let { userId } = RED.nodes.getCredentials(n.id);
                    let dir = storageDir + '/' + MatrixFolderNameFromUserId(userId);
                    if(!fs.pathExistsSync(dir)) {
                        fs.ensureDirSync(dir);
                        node.log("found old '" + oldStorageDir + "' path, copying to new location '" + dir);
                        fs.copySync(oldStorageDir, dir);
                    }
                } catch (err) {
                    console.error(err)
                }
            });

            // rename folder to keep as a backup (and so we don't run again)
            node.log("archiving old config folder '" + oldStorageDir + "' to '" + oldStorageDir + "-backup");
            fs.renameSync(oldStorageDir, oldStorageDir + "-backup");
        }
    }

    /**
     * If a device ID is stored we will use that for the client
     */
    function getStoredDeviceId(localStorage) {
        return localStorage.getItem('my_device_id');
    }

    function storeDeviceId(localStorage, deviceId) {
        localStorage.setItem('my_device_id', deviceId);
    }
}