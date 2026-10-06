# EMWS VNA bridge

A bench or handheld VNA on the LAN (a Keysight FieldFox), offered to the EMWS page on
`127.0.0.1`. Plain Node, no dependencies, public domain.

```sh
node bridge.mjs --fieldfox 192.168.0.50     # or: npm run vna-bridge -- --fieldfox ...
node bridge.mjs --simulate                  # a pretend FieldFox, to try the page
```

The how and the why, the protocol, and what it sends the instrument: `docs/vna-bridge.md`.
`fake-fieldfox.mjs` is the scripted instrument the tests and the smoke run against.
`INSTALL.md` is for the person with the FieldFox: installing Node, running the bridge,
testing it, and what to report back.
