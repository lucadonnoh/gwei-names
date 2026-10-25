# GNS posts

Posts are short documents (blog posts, notes, articles) published under a `.gwei` name. Their text
travels in EIP-4844 blobs, and a small ownerless contract records who vouched for what. Like the rest
of GNS, nothing here has an owner or an operator: anyone can publish, anyone can index, and every
publisher's posts count the same.

gwei.domains runs one publisher and one index, described at the end. Neither is special.

## Contract

`GnsPosts` ([src/GnsPosts.sol](../src/GnsPosts.sol)) has no owner, admin or upgrades; its only balance
is fees in escrow. It checks name ownership against NameNFT
(`0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6`) and emits events, from which clients rebuild
everything with no archive state needed.

A blob's versioned hash depends only on its bytes, and a post's blob is fixed by the post (see
[Blob format](#blob-format)). So the author computes the versioned hash before anyone publishes and
authorizes the post against it. A fee for a publisher sits in escrow until that publisher sends a blob
transaction carrying a blob with exactly that versioned hash (read on-chain with `BLOBHASH`) and calls
`publish`, which pays it out in the same transaction. No other blob matches, so delivery needs no
trust, challenge or proof. A fee nobody delivered for within a day can be taken back.

| Function | Who | Effect |
|---|---|---|
| `authorize(tokenId, postHash, blobHash, publisher)` payable | owner of an active name | `PostAuthorized`; any fee goes into escrow for (`blobHash`, `publisher`) |
| `publish()` | anyone, in a blob transaction | `BlobPublished` for each attached blob; pays the caller the escrow held for it for those blobs |
| `post(tokenId, postHash, blobIndex)` | owner, in a blob transaction | authorize and publish at once (self-publishing) |
| `refund(blobHash, publisher)` | a payer | after `REFUND_DELAY` (1 day), returns their undelivered fee; `FeeRefunded` |
| `remove(tokenId, postHash)` | owner | `PostRemoved` |

```
event PostAuthorized(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author, bytes32 blobHash, address publisher, uint256 fee);
event BlobPublished(bytes32 indexed blobHash, address indexed publisher, uint256 paid);
event FeeRefunded(bytes32 indexed blobHash, address indexed publisher, address indexed payer, uint256 amount);
event PostRemoved(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author);
```

Contract wallets, which can't send blobs, can still `authorize`. Paying a publisher for a blob it
already delivered reverts, so a fee is never paid for work already done.

## Post format

A post is a UTF-8 JSON object, at most 126,968 bytes:

```json
{"v":1,"title":"Exploring the blobspace","body":"Markdown text…"}
```

- `v`: `1`.
- `title`: a non-empty string of at most 200 characters.
- `body`: Markdown (below).
- Other fields are ignored, so later versions can add some.

A post has no date of its own. It is dated by the block of the first blob that carries it, or,
while no blob does yet, by the block of its first authorization.

`postHash` is the keccak-256 hash of the exact bytes. Any byte change is a different post.

### Markdown

Bodies are untrusted, so clients must never render HTML from them. The gateway's renderer
([gateway/markdown.js](../gateway/markdown.js)) supports headings, paragraphs (a newline is a line
break), `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, fenced code blocks, `>` quotes, `-` and
`1.` lists, `---`, `[links](url)`, `![images](url)`, bare `https://` links, and TeX math as `$…$` and
`$$…$$`. Links may be `https`, `http`, `mailto`, `ipfs://`, a `/path` on the name's own site or a
`#anchor`; images may be `https`, `ipfs://` or a `data:image` URL.

## Blob format

A blob is 4096 field elements of 32 bytes. The first byte of each field element is `0x00`; the other
31 carry data, giving a 126,976-byte payload:

```
"gwei" (4 bytes) | version 0x01 | length (3 bytes, big-endian) | post bytes | length | post bytes | … | 0x000000 or end
```

**A post's blob** is the container holding just that post, zero-padded: this is the blob an
authorization names, so its bytes, and therefore its versioned hash, follow from the post alone. The
container can hold several posts, for self-publishers who want to; a post must fit in a single blob.

## Validity

A client shows a post under name `N` (token `T`) when all of these hold:

1. `PostAuthorized(T, h, author, …)` was emitted, and `author` is `N`'s current owner. A sold name
   doesn't carry its previous owner's posts.
2. The client has bytes whose keccak-256 is `h` and that parse as a post. Where the bytes came from
   doesn't matter: a blob, an upload, a friend.
3. There is no `PostRemoved(T, h, author)` after `author`'s latest `PostAuthorized(T, h, …)`.

A post is **on Ethereum** when, additionally, the blob its authorization names was published
(`BlobPublished(blobHash, …)`, by anyone) and that blob's payload contains bytes hashing to `h`.
Clients may show authorized posts that aren't on Ethereum yet, marked as pending. The gateway does
so for one day.

Blobs leave ordinary beacon nodes after about 18 days (4096 epochs). Indexers should fetch the blobs
that authorized posts point at well before then and keep them. Blob archives such as
[Blobscan](https://blobscan.com) keep them longer.

## Publishing

- **Yourself:** send a blob transaction from the name's owner, with the post's blob attached, calling
  `post(tokenId, postHash, 0)`. One transaction, no one else involved.
- **Through a publisher:** build the post's blob, compute its versioned hash, and call
  `authorize(tokenId, postHash, blobHash, publisher)` with the publisher's fee. Upload the post's
  bytes where the publisher can read them. It rebuilds the blob, checks the hash, sends it and is paid
  by `publish`. If it doesn't within a day, call `refund`. Anyone else can also deliver the blob (the
  bytes and the authorization are public); the escrow only ever pays the publisher you named.

## gwei.domains

**API.** The gateway serves its index at `https://gwei.domains/api`, readable from any origin:

| Request | Answer |
|---|---|
| `POST /api/posts` (body: post bytes) | `{ "hash" }`; anyone may upload. Bytes no owner authorizes are dropped after a day; bytes of an already-authorized hash are always accepted |
| `GET /api/posts/<hash>` | the post, its authorizations, and where it is on Ethereum |
| `GET /api/posts/<hash>/raw` | the exact post bytes |
| `GET /api/names/<tokenId>/posts` | posts shown for a name, newest first |
| `GET /api/authors/<address>/paid` | fees an address put in escrow, latest per blob and publisher (to find refunds; the contract says what is left) |
| `GET /api/posts/recent` | newest posts across all names |
| `GET /api/blobs/<versionedHash>` | a blob the index fetched, for 30 days after it did |
| `POST /api/posts/preview` (body: post bytes) | `{ "title", "html" }` rendered by the gateway |
| `POST /api/sync` | asks the index to catch up now (at most every 10 seconds) |

The index reads events every minute from the owner's node, or, when it's down, only events two
public RPCs agree on. It fetches the blobs that claim an authorized post (those sent by the
publisher the author named first) from Blobscan or a public beacon API, takes only bytes whose KZG
commitment matches the versioned hash, and records only the claimed entries a blob really contains.
A claim that arrives after its blob was checked gets the blob checked again, so an early junk claim
can't hide a later real one. A post
carried by a blob is kept for good; blob bytes for 30 days. Posts show on a name's page when it has
no website set, at `https://<name>.gwei.domains/posts/…`, with an Atom feed at `/feed.xml`.

**Publisher.** The gwei.domains publisher (`posts/poster/`) delivers blobs authors paid it for. It
rebuilds each blob from the post's bytes (`GET /api/posts/<hash>/raw`) and checks its versioned hash
is the one the author named; when several posts claim the same blob it tries each, so a wrong claim
can't block the right one. It counts as paid only the deposits for a blob that can't be refunded for
at least six more hours, sends a blob only if those cover sending it alone at current prices with some
headroom, packs up to six blobs into one transaction, and never lets a transaction spend more than its
blobs' safe deposits, replacements included. The dapp pays three times the current cost of a one-blob
transaction. The publisher waits three blocks before acting on a payment and pins every published blob
that carries an authorized post to IPFS after checking it against its versioned hash with KZG.
