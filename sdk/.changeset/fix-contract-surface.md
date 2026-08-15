---
'@donnoh/gns-utils': patch
---

Correct the exported NameNFT ABI to match the deployed ownerless contract and correct
`MAX_SUBDOMAIN_DEPTH` from 5 to 10. Deprecate the unrelated legacy `BASE_PORTAL` export while
retaining it for compatibility.
