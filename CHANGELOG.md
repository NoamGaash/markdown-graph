# Changelog

## [0.1.7](https://github.com/NoamGaash/markdown-graph/compare/v0.1.6...v0.1.7) (2026-06-01)


### Bug Fixes

* delete setup-node .npmrc before publish to allow OIDC Trusted Publisher ([21ecccb](https://github.com/NoamGaash/markdown-graph/commit/21ecccb625900bf26b423811d35018d6e936fb22))

## [0.1.6](https://github.com/NoamGaash/markdown-graph/compare/v0.1.5...v0.1.6) (2026-06-01)


### Bug Fixes

* pass token: '' to setup-node so NODE_AUTH_TOKEN stays unset for OIDC ([6cfa40f](https://github.com/NoamGaash/markdown-graph/commit/6cfa40f09e273e7e7222ed42921dacf67f02f7ba))

## [0.1.5](https://github.com/NoamGaash/markdown-graph/compare/v0.1.4...v0.1.5) (2026-06-01)


### Bug Fixes

* override NODE_AUTH_TOKEN to empty so npm uses OIDC Trusted Publisher ([3f1529e](https://github.com/NoamGaash/markdown-graph/commit/3f1529efc8398224d894d0417b2b5074aff844d0))

## [0.1.4](https://github.com/NoamGaash/markdown-graph/compare/v0.1.3...v0.1.4) (2026-06-01)


### Bug Fixes

* remove registry-url from setup-node to allow npm OIDC Trusted Publisher flow ([0e24338](https://github.com/NoamGaash/markdown-graph/commit/0e24338fff571f60b5c4a1b680a3226513cad21b))

## [0.1.3](https://github.com/NoamGaash/markdown-graph/compare/v0.1.2...v0.1.3) (2026-06-01)


### Bug Fixes

* consolidate into deploy.yml to match Trusted Publisher config ([ff1096d](https://github.com/NoamGaash/markdown-graph/commit/ff1096d4bc2ef94429fc787b620c047cc336b6b6))

## [0.1.2](https://github.com/NoamGaash/markdown-graph/compare/v0.1.1...v0.1.2) (2026-06-01)


### Bug Fixes

* add contents: read permission to npm-publish job ([7656a09](https://github.com/NoamGaash/markdown-graph/commit/7656a093cda9b8163e8cd8476a2b06fef9e83262))
* move npm publish into release-please workflow to avoid GITHUB_TOKEN trigger limitation ([b49b799](https://github.com/NoamGaash/markdown-graph/commit/b49b799b1066cfee671dc6affb0a70acebacb0dd))

## [0.1.1](https://github.com/NoamGaash/markdown-graph/compare/v0.1.0...v0.1.1) (2026-06-01)


### Bug Fixes

* auto-open browser after generating graphs ([ca975ed](https://github.com/NoamGaash/markdown-graph/commit/ca975ed9e80ade2900f9cec6beed8f58ac7a96fd))
