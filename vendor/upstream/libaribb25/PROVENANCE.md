# libaribb25 source snapshot

- Origin: https://github.com/shirow-github/libaribb25.git
- Release tag: `v0.2.10`
- Tag object: `51dfd21fd803062520131ab52d987ac5897eb2f3`
- Commit: `b978fe5caf6bfe162e944ad4d323b7c0205276e3`
- License: ISC (`LICENCE`)

This source-only snapshot retains the TS section parser, MULTI2 core, and the
upstream `arib_std_b25.c/.h` facade plus its interface/error headers. The
PC/SC implementation `b_cas_card.c`, `td.c`, card integration, binaries, keys,
firmware, and captured TS remain excluded. The facade is only exercised for
create/configure/release with EMM disabled and no card or TS input; it is not a
descrambler runtime and is not replaced by TypeScript or a mock card.

The added upstream files are fixed by `vendor/SOURCE_LOCK.json`:

- `src/arib_std_b25.c`: `43cb2b61924f302a006dfc783d82496b5f8db66cc41f714aa85ee989b9bae9d0`
- `src/arib_std_b25.h`: `209ad75088537035674369103e13e4a5a23f8f0abe227aff10030a7632cc304e`
- `src/arib_std_b25_error_code.h`: `a717e912e7a27a36b39731f791860bd07d6a369ea010359e1463aef532a78f2a`
- `src/b_cas_card.h`: `498e4f47461f25609cfafd80b13a45aac07c4913bd663462a19afe5b5b1227c7`
- `src/b_cas_card_error_code.h`: `62227cc836d3bbdf2f1b92882877d6978aeb60aaee8bf3edff55e91605b6e871`

The snapshot is not a descrambler runtime and does not claim B25 decryption.
The build-only ABI accepts no TS or card input and returns fixed diagnostics
only.
