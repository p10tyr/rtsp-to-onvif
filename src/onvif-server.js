const soap = require('soap');
const http = require('http');
const dgram = require('dgram');
const xml2js = require('xml2js');
const uuid = require('node-uuid');
const url = require('url');
const fs = require('fs');
const logger = require('simple-node-logger');

const { getIp4FromMac } = require('./net-tools')
const EventsProxy = require('./events-proxy')
const PtzProxy = require('./ptz-proxy')
const ImagingProxy = require('./imaging-proxy')

Date.prototype.stdTimezoneOffset = function () {
    let jan = new Date(this.getFullYear(), 0, 1);
    let jul = new Date(this.getFullYear(), 6, 1);
    return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

Date.prototype.isDstObserved = function () {
    return this.getTimezoneOffset() < this.stdTimezoneOffset();
}

module.exports = class OnvifServer {
    constructor(logger, config) {
        this.config = config;
        this.logger = logger;
        this.eventsProxy = new EventsProxy(logger, config);
        this.ptzProxy = config.ptz ? new PtzProxy(logger, config) : null;
        this.imagingProxy = new ImagingProxy(logger, config);

        this.config.hostname = getIp4FromMac(logger, this.config.mac);
        if (!this.config.hostname)
            return -1;

        this.videoSource = {
            attributes: {
                token: 'video_src_token'
            },
            Framerate: this.config.highQuality.framerate,
            Resolution: { Width: this.config.highQuality.width, Height: this.config.highQuality.height }
        };

        this.profiles = [
            {
                Name: 'MainStream',
                attributes: {
                    token: 'main_stream'
                },
                VideoSourceConfiguration: {
                    Name: 'VideoSource',
                    UseCount: 2,
                    attributes: {
                        token: 'video_src_config_token'
                    },
                    SourceToken: 'video_src_token',
                    Bounds: { attributes: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height } }
                },
                VideoEncoderConfiguration: {
                    attributes: {
                        token: 'encoder_hq_config_token'
                    },
                    Name: 'CardinalHqCameraConfiguration',
                    UseCount: 1,
                    Encoding: 'H264',
                    Resolution: {
                        Width: this.config.highQuality.width,
                        Height: this.config.highQuality.height
                    },
                    Quality: this.config.highQuality.quality,
                    RateControl: {
                        FrameRateLimit: this.config.highQuality.framerate,
                        EncodingInterval: 1,
                        BitrateLimit: this.config.highQuality.bitrate
                    },
                    H264: {
                        GovLength: this.config.highQuality.framerate,
                        H264Profile: 'Main'
                    },
                    SessionTimeout: 'PT1000S'
                }
            }
        ];

        if (this.config.lowQuality) {
            this.profiles.push(
                {
                    Name: 'SubStream',
                    attributes: {
                        token: 'sub_stream'
                    },
                    VideoSourceConfiguration: {
                        Name: 'VideoSource',
                        UseCount: 2,
                        attributes: {
                            token: 'video_src_config_token'
                        },
                        SourceToken: 'video_src_token',
                        Bounds: { attributes: { x: 0, y: 0, width: this.config.highQuality.width, height: this.config.highQuality.height } }
                    },
                    VideoEncoderConfiguration: {
                        attributes: {
                            token: 'encoder_lq_config_token'
                        },
                        Name: 'CardinalLqCameraConfiguration',
                        UseCount: 1,
                        Encoding: 'H264',
                        Resolution: {
                            Width: this.config.lowQuality.width,
                            Height: this.config.lowQuality.height
                        },
                        Quality: this.config.lowQuality.quality,
                        RateControl: {
                            FrameRateLimit: this.config.lowQuality.framerate,
                            EncodingInterval: 1,
                            BitrateLimit: this.config.lowQuality.bitrate
                        },
                        H264: {
                            GovLength: this.config.lowQuality.framerate,
                            H264Profile: 'Main'
                        },
                        SessionTimeout: 'PT1000S'
                    }
                }
            );
        }

        this.onvif = {
            DeviceService: {
                Device: {
                    GetSystemDateAndTime: (args) => {
                        let now = new Date();

                        let offset = now.getTimezoneOffset();
                        let abs_offset = Math.abs(offset);
                        let hrs_offset = Math.floor(abs_offset / 60);
                        let mins_offset = (abs_offset % 60);
                        let tz = 'UTC' + (offset < 0 ? '-' : '+') + hrs_offset + (mins_offset === 0 ? '' : ':' + mins_offset);

                        return {
                            SystemDateAndTime: {
                                DateTimeType: 'NTP',
                                DaylightSavings: now.isDstObserved(),
                                TimeZone: {
                                    TZ: tz
                                },
                                UTCDateTime: {
                                    Time: { Hour: now.getUTCHours(), Minute: now.getUTCMinutes(), Second: now.getUTCSeconds() },
                                    Date: { Year: now.getUTCFullYear(), Month: now.getUTCMonth() + 1, Day: now.getUTCDate() }
                                },
                                LocalDateTime: {
                                    Time: { Hour: now.getHours(), Minute: now.getMinutes(), Second: now.getSeconds() },
                                    Date: { Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate() }
                                },
                                Extension: {}
                            }
                        };
                    },

                    GetCapabilities: (args) => {
                        let response = {
                            Capabilities: {}
                        };

                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Device') {
                            response.Capabilities['Device'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                                Network: {
                                    IPFilter: false,
                                    ZeroConfiguration: false,
                                    IPVersion6: false,
                                    DynDNS: false,
                                    Extension: {
                                        Dot11Configuration: false,
                                        Extension: {}
                                    }
                                },
                                System: {
                                    DiscoveryResolve: false,
                                    DiscoveryBye: false,
                                    RemoteDiscovery: false,
                                    SystemBackup: false,
                                    SystemLogging: false,
                                    FirmwareUpgrade: false,
                                    SupportedVersions: {
                                        Major: 2,
                                        Minor: 5
                                    },
                                    Extension: {
                                        HttpFirmwareUpgrade: false,
                                        HttpSystemBackup: false,
                                        HttpSystemLogging: false,
                                        HttpSupportInformation: false,
                                        Extension: {}
                                    }
                                },
                                IO: {
                                    InputConnectors: 0,
                                    RelayOutputs: 1,
                                    Extension: {
                                        Auxiliary: false,
                                        AuxiliaryCommands: '',
                                        Extension: {}
                                    }
                                },
                                Security: {
                                    'TLS1.1': false,
                                    'TLS1.2': false,
                                    OnboardKeyGeneration: false,
                                    AccessPolicyConfig: false,
                                    'X.509Token': false,
                                    SAMLToken: false,
                                    KerberosToken: false,
                                    RELToken: false,
                                    Extension: {
                                        'TLS1.0': false,
                                        Extension: {
                                            Dot1X: false,
                                            RemoteUserHandling: false
                                        }
                                    }
                                },
                                Extension: {}
                            };
                        }
                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Media') {
                            response.Capabilities['Media'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                                StreamingCapabilities: {
                                    RTPMulticast: false,
                                    RTP_TCP: true,
                                    RTP_RTSP_TCP: true,
                                    Extension: {}
                                },
                                Extension: {
                                    ProfileCapabilities: {
                                        MaximumNumberOfProfiles: this.profiles.length
                                    }
                                }
                            }
                        }

                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Events') {
                            response.Capabilities['Events'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/Events`,
                                WSSubscriptionPolicySupport: false,
                                WSPullPointSupport: true,
                                WSPausableSubscriptionManagerInterfaceSupport: false
                            };
                        }

                        if (this.ptzProxy && (args.Category === undefined || args.Category == 'All' || args.Category == 'PTZ')) {
                            response.Capabilities['PTZ'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/PTZ`
                            };
                        }

                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Imaging') {
                            response.Capabilities['Imaging'] = {
                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/Imaging`
                            };
                        }

                        return response;
                    },

                    GetServices: (args) => {
                        return {
                            Service: [
                                {
                                    Namespace: 'http://www.onvif.org/ver10/device/wsdl',
                                    XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`,
                                    Version: { Major: 2, Minor: 5 }
                                },
                                {
                                    Namespace: 'http://www.onvif.org/ver10/media/wsdl',
                                    XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/media_service`,
                                    Version: { Major: 2, Minor: 5 }
                                },
                                {
                                    Namespace: 'http://www.onvif.org/ver10/events/wsdl',
                                    XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/Events`,
                                    Version: { Major: 2, Minor: 5 }
                                },
                                ...(this.ptzProxy ? [{
                                    Namespace: 'http://www.onvif.org/ver20/ptz/wsdl',
                                    XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/PTZ`,
                                    Version: { Major: 2, Minor: 5 }
                                }] : []),
                                {
                                    Namespace: 'http://www.onvif.org/ver20/imaging/wsdl',
                                    XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/Imaging`,
                                    Version: { Major: 2, Minor: 5 }
                                }
                            ]
                        };
                    },

                    GetDeviceInformation: (args) => {
                        return {
                            Manufacturer: 'rtsp-2-onvif',
                            Model: `${this.config.name}`,
                            FirmwareVersion: '1.0.0',
                            SerialNumber: `${this.config.name.replace(' ', '_')}-0000`,
                            HardwareId: `${this.config.name.replace(' ', '_')}-1001`
                        };
                    }

                }
            },

            MediaService: {
                Media: {
                    GetProfiles: (args) => {
                        return {
                            Profiles: this.profiles
                        };
                    },

                    GetVideoSources: (args) => {
                        return {
                            VideoSources: [
                                this.videoSource
                            ]
                        };
                    },

                    GetSnapshotUri: (args) => {
                        let uri = `http://${this.config.hostname}:${this.config.ports.server}/snapshot.png`;
                        if (args.ProfileToken == 'sub_stream' && this.config.lowQuality && this.config.lowQuality.snapshot)
                            uri = `http://${this.config.hostname}:${this.config.ports.snapshot}${this.config.lowQuality.snapshot}`;
                        else if (this.config.highQuality.snapshot)
                            uri = `http://${this.config.hostname}:${this.config.ports.snapshot}${this.config.highQuality.snapshot}`;

                        return {
                            MediaUri: {
                                Uri: uri,
                                InvalidAfterConnect: false,
                                InvalidAfterReboot: false,
                                Timeout: 'PT30S'
                            }
                        };
                    },

                    GetStreamUri: (args) => {
                        let path = this.config.highQuality.rtsp;
                        if (args.ProfileToken == 'sub_stream' && this.config.lowQuality)
                            path = this.config.lowQuality.rtsp;

                        return {
                            MediaUri: {
                                Uri: `rtsp://${this.config.hostname}:${this.config.ports.rtsp}${path}`,
                                InvalidAfterConnect: false,
                                InvalidAfterReboot: false,
                                Timeout: 'PT30S'
                            }
                        };
                    }
                }
            }
        };
    }

    listen(request, response) {
        let action = url.parse(request.url, true).pathname;
        if (action == '/snapshot.png') {
            let image = fs.readFileSync('./resources/snapshot.png');
            response.writeHead(200, { 'Content-Type': 'image/png' });
            response.end(image, 'binary');
        } else if (this.eventsProxy.matches(action)) {
            this.eventsProxy.handle(request, response);
        } else if (this.ptzProxy && this.ptzProxy.matches(action)) {
            this.ptzProxy.handle(request, response);
        } else if (this.imagingProxy.matches(action)) {
            this.imagingProxy.handle(request, response);
        } else {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.write('404 Not Found\n');
            response.end();
        }
    }

    startHttpServer() {
        this.logger.info(`SERVER: ${this.config.name} - HTTP listening on ${this.config.hostname}:${this.config.ports.server}`);

        this.server = http.createServer(this.listen.bind(this));
        this.server.listen(this.config.ports.server, this.config.hostname);

        this.deviceService = soap.listen(this.server, {
            path: '/onvif/device_service',
            services: this.onvif,
            xml: fs.readFileSync('./wsdl/device_service.wsdl', 'utf8'),
            forceSoap12Headers: true
        });
       

        this.mediaService = soap.listen(this.server, {
            path: '/onvif/media_service',
            services: this.onvif,
            xml: fs.readFileSync('./wsdl/media_service.wsdl', 'utf8'),
            forceSoap12Headers: true
        });
        
    }

    enableDebugOutput() {
        this.deviceService.log = function(type, data, req){
            console.debug(`SERVER: ${data}`);
            //there is no logger in this context
        };
        this.mediaService.log = function(type, data, req){
            console.debug(`SERVER: ${data}`);
            //there is no logger in this context
        };
        // this.deviceService.on('request', (request, methodName) => {
        //     this.logger.debug(`SERVER: ${this.config.name} - DeviceService: ${methodName}`);
        // });

        // this.mediaService.on('request', (request, methodName) => {
        //     this.logger.debug(`SERVER: ${this.config.name} -  MediaService: ${methodName}`);
        // });
    }

    startDiscovery() {
        this.discoveryMessageNo = 0;
        this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.discoverySocket.on('error', (err) => {
            this.logger.error(`DISCOVERY: ${this.config.name} - socket error: ${err.message}`);
        });

        this.discoverySocket.on('message', (message, remote) => {

            this.logger.debug(`SERVER: ${this.config.name} - Discovery request from ${remote.address}:${remote.port}`);

            xml2js.parseString(message.toString(), { tagNameProcessors: [xml2js['processors'].stripPrefix] }, (err, result) => {
                let probeUuid = result['Envelope']['Header'][0]['MessageID'][0];
                let probeType = '';
                try {
                    probeType = result['Envelope']['Body'][0]['Probe'][0]['Types'][0];
                } catch (err) {
                    probeType = '';
                }

                if (typeof probeType === 'object')
                    probeType = probeType._;

                if (probeType === '' || probeType.indexOf('NetworkVideoTransmitter') > -1) {
                    let response =
                        `<?xml version="1.0" encoding="UTF-8"?>
                        <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
                            <SOAP-ENV:Header>
                                <wsa:MessageID>uuid:${uuid.v1()}</wsa:MessageID>
                                <wsa:RelatesTo>${probeUuid}</wsa:RelatesTo>
                                <wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
                                <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
                                <d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${this.discoveryMessageNo}" InstanceId="1234567890"/>
                            </SOAP-ENV:Header>
                            <SOAP-ENV:Body>
                                <d:ProbeMatches>
                                    <d:ProbeMatch>
                                        <wsa:EndpointReference>
                                            <wsa:Address>urn:uuid:${this.config.uuid}</wsa:Address>
                                        </wsa:EndpointReference>
                                        <d:Types>dn:NetworkVideoTransmitter</d:Types>
                                        <d:Scopes>
                                            onvif://www.onvif.org/type/video_encoder
                                            ${this.ptzProxy ? 'onvif://www.onvif.org/type/ptz' : ''}
                                            onvif://www.onvif.org/hardware/onvif
                                            onvif://www.onvif.org/name/${this.config.name}
                                            onvif://www.onvif.org/location/
                                        </d:Scopes>
                                        <d:XAddrs>http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service</d:XAddrs>
                                        <d:MetadataVersion>1</d:MetadataVersion>
                                    </d:ProbeMatch>
                                </d:ProbeMatches>
                            </SOAP-ENV:Body>
                        </SOAP-ENV:Envelope>`;

                    this.discoveryMessageNo++;
                    let responseBuffer = Buffer.from(response);
                    const replySocket = dgram.createSocket('udp4');
                    replySocket.on('error', (sendErr) => {
                        this.logger.warn(`DISCOVERY: ${this.config.name} - reply send error: ${sendErr.message}`);
                        replySocket.close();
                    });
                    replySocket.send(responseBuffer, 0, responseBuffer.length, remote.port, remote.address, () => {
                        replySocket.close();
                    });
                }
            });
        });

        this.discoverySocket.bind(3702, () => {
            return this.discoverySocket.addMembership('239.255.255.250', this.config.hostname);
        });
    }

    getHostname() {
        return this.config.hostname;
    }
};