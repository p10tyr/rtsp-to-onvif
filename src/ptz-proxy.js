const { forwardSoap } = require('./soap-forwarder');

const PROFILE_TOKEN_MAP = {
    main_stream: 'Profile_1',
    sub_stream: 'Profile_2',
};

function rewriteProfileTokens(body) {
    let out = body;
    for (const [ours, theirs] of Object.entries(PROFILE_TOKEN_MAP)) {
        out = out.replace(new RegExp(`>${ours}<`, 'g'), `>${theirs}<`);
        out = out.replace(new RegExp(`="${ours}"`, 'g'), `="${theirs}"`);
    }
    return out === body ? null : out;
}

module.exports = class PtzProxy {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
    }

    matches(pathname) {
        return pathname === '/onvif/PTZ' || pathname === '/onvif/ptz_service';
    }

    upstreamPtzUrl() {
        const port = (this.config.target.ports && this.config.target.ports.snapshot) || 80;
        return `http://${this.config.target.hostname}:${port}/onvif/PTZ`;
    }

    async handle(request, response) {
        await forwardSoap({
            logger: this.logger,
            name: `${this.config.name}/ptz`,
            request, response,
            upstreamUrl: this.upstreamPtzUrl(),
            rewriteRequest: rewriteProfileTokens,
        });
    }
};
