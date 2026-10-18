# Changelog

## [1.4.1](https://github.com/nodemailer/libbase64/compare/v1.4.0...v1.4.1) (2026-10-18)


### Bug Fixes

* skip characters outside of latin1 in decode() ([a46d7d0](https://github.com/nodemailer/libbase64/commit/a46d7d05306d5cb8c569135d1d80f90baf0cb66b))

## [1.4.0](https://github.com/nodemailer/libbase64/compare/v1.3.3...v1.4.0) (2026-10-18)


### Features

* rewrite in TypeScript with ES module and CommonJS builds ([27f40e1](https://github.com/nodemailer/libbase64/commit/27f40e19e994f44460800fa195c04f1172abe013))


### Bug Fixes

* **decoder:** skip 8-bit input bytes instead of reading them as base64 characters ([27f40e1](https://github.com/nodemailer/libbase64/commit/27f40e19e994f44460800fa195c04f1172abe013))
* **encoder:** encode a plain Uint8Array instead of its comma separated byte values ([27f40e1](https://github.com/nodemailer/libbase64/commit/27f40e19e994f44460800fa195c04f1172abe013))

## [1.3.3](https://github.com/nodemailer/libbase64/compare/v1.3.2...v1.3.3) (2026-10-14)


### Bug Fixes

* **decoder:** decode padded segments into one buffer instead of a Buffer per segment ([0c01914](https://github.com/nodemailer/libbase64/commit/0c0191457e343769e8b68adb4052d71fa267abd1))

## [1.3.2](https://github.com/nodemailer/libbase64/compare/v1.3.1...v1.3.2) (2026-10-04)


### Bug Fixes

* **encoder:** wrap base64 lines without regular expressions, independent of chunk boundaries ([2c76a48](https://github.com/nodemailer/libbase64/commit/2c76a489f1444600b5645a44c933e159ac8e920f))

## [1.3.1](https://github.com/nodemailer/libbase64/compare/v1.3.0...v1.3.1) (2026-09-28)


### Bug Fixes

* **decoder:** decode every padded segment instead of stopping at the first padding ([d9ba154](https://github.com/nodemailer/libbase64/commit/d9ba154ba13e45338936a55acec417dfb6ae2e52))

## [1.3.0](https://github.com/nodemailer/libbase64/compare/v1.2.1...v1.3.0) (2024-02-23)


### Features

* **deploy:** Added autodeploy system ([f53cb2e](https://github.com/nodemailer/libbase64/commit/f53cb2e8ea3c4900288a96284914da2c35bffe9f))
