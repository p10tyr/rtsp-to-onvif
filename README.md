# Virtual ONVIF Proxy

Fakes ONVIF Device and Media services in front of an RTSP camera so UniFi Protect can adopt it as a native ONVIF cam, then proxies ONVIF Events, PTZ, and Imaging through to the real camera.

> **In UniFi Protect 7.1.60:**
>
> - PTZ joystick control on third-party cameras works without an AI Port. The AI Port is the documented requirement; this proxy makes it work without one.
> - Motion events from third-party cameras show up on the Protect timeline.

Forked from [p10tyr/rtsp-to-onvif](https://github.com/p10tyr/rtsp-to-onvif), which built the adoption and streaming pieces. This fork adds the service passthroughs that make the two things above work.

## What works

- **Motion events** via Protect 7.1.60's third-party motion alert pipeline. `CreatePullPointSubscription` returns a subscription URL hosted on the proxy itself, so the cam stays unreachable on its isolated network. `PullMessages`, `Renew`, `Unsubscribe`, and per-subscription cleanup all work.
- **PTZ control** for cams with `ptz: true` in config. `ContinuousMove`, `Stop`, `AbsoluteMove`, `RelativeMove`, `GetStatus`, presets. Profile tokens are translated (`main_stream` to `Profile_1`, etc.) so Hikvision-family cams accept the requests instead of returning `ter:NoProfile`.
- **Imaging settings** for every cam. Brightness, contrast, IR-cut, white balance, focus. Same token translation pattern, `video_src_token` to `VideoSource_1`.
- **No credentials in config.** The `wsse:Security` UsernameToken Protect sends at every request is forwarded upstream unchanged, so the password you typed at adoption is the one the cam actually validates.
- **Snapshots** through the existing TCP forwarder. The cam returns a Digest auth challenge, Protect handles the handshake, the image flows back. The upstream README says snapshot is unimplemented; that's stale, it works.

## Tested on

- 4x Luma Surveillance LUM-310-DOM-IP-BL (Hikvision OEM), firmware V5.5.52
- 1x Luma LUM-310-PTZ-IP-WH, firmware V5.5.6
- 1x Luma LUM-510-PTZ-IP-WH, firmware V5.5.6
- UDM with UniFi Protect 7.1.60
- Running as a systemd service on a Raspberry Pi (not the upstream's Docker path, but macvlan works the same way)

The profile and video-source token translation tables are hardcoded against the Hikvision/Luma `Profile_N` / `VideoSource_N` convention. Dahua, Reolink, Amcrest etc. likely use different tokens. If you try this with one of those and PTZ or imaging returns `ter:InvalidArgVal`, open an issue with what your cam's `GetProfiles` and `GetVideoSources` return.

## Performance

Sample stats from a Raspberry Pi 4 Model B (4 GB, Debian, Node 18.13), six cameras configured, under normal load (Protect polling for motion events, fetching snapshots, RTSP forwarding through to all 6 cams):

- Memory: around 380 MB RSS after ~1 hour uptime. About 10% of the Pi's 4 GB. Most of the footprint is `node-tcp-proxy` buffering active RTSP streams; the ONVIF SOAP layer itself is minor.
- CPU: ~65% of one core on average (Node's JS work is single-threaded), which is roughly 16% of total on a 4-core Pi 4.
- ~25 open TCP connections (RTSP forwarders, snapshot connections, ONVIF SOAP listeners across 6 virtual cams).
- 1 process, ~11 threads (Node main + libuv pool + V8 helpers).

The Pi 4 has plenty of headroom. Smaller hardware (Pi 3, Zero 2 W) is untested.

## Install

Same docker compose flow as upstream:

```bash
mkdir rtsp-to-onvif && cd rtsp-to-onvif
wget https://raw.githubusercontent.com/connorgallopo/rtsp-to-onvif/release/compose.yaml
wget https://raw.githubusercontent.com/connorgallopo/rtsp-to-onvif/release/config.example.yaml
cp config.example.yaml config.yaml
nano config.yaml
sudo docker compose up
```

If the cameras show up in Protect's adoption queue, you're good. `sudo docker compose up -d` to detach.

## Config

Bare-minimum per camera, with the new `ptz: true` flag on cams that support PTZ:

```yaml
onvif:
  - name: FrontDoor
    dev: eth0
    ptz: false                        # set true if this cam supports PTZ
    target:
      hostname: 192.168.1.187
      ports:
        rtsp: 554
        snapshot: 80
    highQuality:
      rtsp: /Streaming/Channels/101/
      snapshot: /ISAPI/Streaming/Channels/101/picture
      width: 1920
      height: 1080
      framerate: 30
      bitrate: 4096
      quality: 4
    ports:
      server: 8081
      rtsp: 8554
      snapshot: 8080
```

MAC and UUID are auto-generated on first run.

## Notes

- Credentials go in Protect at adoption time. They're not stored on the proxy or in `config.yaml`. The proxy forwards the WS-Security header Protect sends, so the password Protect knows is the one the cam validates.
- PTZ is gated by a per-cam `ptz: true` flag. Auto-detection would need either credentials in config (against the no-creds-in-config rule) or refactoring `device_service` out of the SOAP library binding.
- Each downstream client gets its own upstream event subscription. Cams advertise `MaxPullPoints=10`, the proxy caps at 32 active subs per cam, so a single Protect controller is fine. Multi-consumer setups (Protect plus Frigate plus Scrypted on the same proxy) burn upstream slots 1:1 with consumers.

## Not tested

- Smart event topics (`tns1:RuleEngine/ObjectDetector`, person/vehicle classifiers). The cams I have don't emit them. The proxy passes through whatever topics the cam advertises, so if your cam emits these they should reach Protect.
- Non-Hikvision-family cameras. Profile and video-source token translation tables assume the `Profile_N` / `VideoSource_N` naming convention.
- Protect versions other than 7.1.60.
- Hardware smaller than a Pi 4.

## Credits

Daniela Hase wrote the original virtual ONVIF server. Piotr Kula (p10tyr) made it a docker appliance with auto MAC/IP registration and is upstream of this fork.
