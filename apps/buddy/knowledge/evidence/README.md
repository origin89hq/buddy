# Controller evidence

This is the exact first-party Rust source used by the catalogue integration checks at extraction. `manifest.json` records its repository, commit, original path and SHA-256. The file is evidence, not a runtime dependency or a second firmware implementation. It retains the upstream MIT OR Apache-2.0 license.

When reviewing an integration update, replace this snapshot from an explicit controller commit and update both the manifest and the affected integration evidence hashes. The catalogue refuses missing or mismatched evidence. Private vendor documents remain external citations and are not copied here.
