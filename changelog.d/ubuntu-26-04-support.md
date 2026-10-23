### Changed

- The Linux docs and the Linux download page on openbot.run now name Ubuntu 26.04 LTS. OpenBot
  0.48.1 runs on Ubuntu 26.04 with the Electron sandbox on.

### Fixed

- Remote desktop now starts on Ubuntu 26.04 LTS with the x64 AppImage and on a self-hosted server.
  Before, its runtime needed `libminiupnpc.so.17` and `libicuuc.so.74`, which Ubuntu 26.04 does not
  have. The server install now also installs `libnuma1`, which remote desktop needs.
