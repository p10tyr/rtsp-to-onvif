const { forwardSoap } = require('./soap-forwarder');

const VIDEO_SOURCE_TOKEN_MAP = {
    video_src_token: 'VideoSource_1',
};

function rewriteVideoSourceTokens(body) {
    let out = body;
    for (const [ours, theirs] of Object.entries(VIDEO_SOURCE_TOKEN_MAP)) {
        out = out.replace(new RegExp(`>${ours}<`, 'g'), `>${theirs}<`);
        out = out.replace(new RegExp(`="${ours}"`, 'g'), `="${theirs}"`);
    }
    return out === body ? null : out;
}

module.exports = class ImagingProxy {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
    }

    matches(pathname) {
        return pathname === '/onvif/Imaging' || pathname === '/onvif/imaging_service';
    }

    upstreamImagingUrl() {
        const port = (this.config.target.ports && this.config.target.ports.snapshot) || 80;
        return `http://${this.config.target.hostname}:${port}/onvif/Imaging`;
    }

    async handle(request, response) {
        await forwardSoap({
            logger: this.logger,
            name: `${this.config.name}/imaging`,
            request, response,
            upstreamUrl: this.upstreamImagingUrl(),
            rewriteRequest: rewriteVideoSourceTokens,
        });
    }
};
