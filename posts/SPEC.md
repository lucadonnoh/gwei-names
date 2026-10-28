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
- `replies` (optional): `true` takes replies (below); without it a post takes none. Writers put it
  after `body` and only when it is `true`.
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
[Blobscan](https://blobscan.com) keep them longer, and mirrors keep posts on IPFS for good (below).

## Mirroring

A post's bytes are named by its `postHash`, so they can be kept and served by anyone, and checked by
anyone against Ethereum. On IPFS:

- **A post** is a raw block whose CID is its `postHash`: CIDv1, raw codec (`0x55`), keccak-256 multihash
  (`0x1b`), base32 (`bafkrwi…`). It follows from the `PostAuthorized` event alone, so a client can
  fetch a post from any IPFS node without asking an index. Kubo: `ipfs block put --cid-codec raw
  --mhtype keccak-256 --pin post.json`.
- **A blob** is a raw block named by its sha-256: CIDv1, raw codec, sha2-256 (`bafkrei…`), what
  `ipfs add --cid-version=1 --raw-leaves` gives for its 131,072 bytes. It doesn't follow from the
  versioned hash (a hash of the KZG commitment), but a post's own blob follows from the post.

A mirror reads the contract's events, and for each post that a published blob was named for: gets
bytes that hash to the post from anywhere, shows that a published blob carries them (rebuilding the
post's own blob and checking its versioned hash with KZG, or fetching the blob and checking it), and
pins the post and the blob under the CIDs above. [`gwei-mirror`](../mirror/) does exactly this
against any IPFS node. An index that loses its copies gets them back the same way, from IPFS.

## Replies

A reply is a [calldata-chat](https://ethchat.gwei.limo) message, the protocol ethchat runs on. No
contract and no publisher are involved: the transaction is the reply, and its sender is its author.

- **Room.** A post's room is the calldata-chat named room `gwei-` + the first 43 hex digits of its
  `postHash` (lowercase, after `0x`): the first 20 bytes of SHA-256(`calldata-chat/<that name>/v1`).
  Nobody holds a key for it. Any calldata-chat client can open a post's thread under that name.
- **Reply.** A successful top-level transaction from the replier to the room, of exactly 1 wei, whose
  input is `0x01` followed by 1 to 1,024 bytes of UTF-8. Anything else sent to the room is not a reply:
  another value, another first byte, invalid UTF-8, a call made from inside a contract, a reverted
  transaction. Smart wallets can reply only by sending such a transaction themselves.
- **Who shows.** Every reply, with the name ethchat shows for its sender: the primary GNS name, else
  WNS, else ENS, each only if it resolves back to the sender (GNS's and WNS's `reverseResolve` check
  that themselves; ENS's Universal Resolver reverts otherwise). An ENS name must also be exactly its
  ENSIP-15 normalization, so look-alikes don't show, and offchain (CCIP-Read) names aren't followed.
  A sender with none shows as their address.
- **On or off.** Replies are opt-in: a post takes them only if its bytes say `"replies": true`, so posts
  written before replies existed, or by a publisher that doesn't know them, take none. The name's
  `gwei-replies` text record decides first: space-separated `<post id>:on` or `<post id>:off` entries
  (the post id is the 12 hex digits after `0x`, as in its URL; the last entry for a post wins), so an
  owner can turn an old post on, or change their mind, without a new post. It is a display choice:
  replies sent to the room stay on Ethereum, and the gateway's API lists them all. A post that takes
  no replies has no reply section at all.

**Sending.** A post page has a reply box, but a post page lives on its name's own host, where the
owner's website takes over whenever they set one, so a wallet is never connected there. The box's
Reply opens `https://gwei.domains/#reply/<hash>/<name>/<text>` in a small window. Any site can open
that link with any text, so the window only fills the text in, uses the name only to pick which of the
post's authorizations to credit (it must be one), checks the post takes replies, and sends only when
Send is pressed there and the wallet confirms. Once the transaction is in a block, the window posts
`{ "type": "gwei-reply", "hash", "tx", "text" }` to the page that opened it, addressed only to that
name's origins on gwei.limo and gwei.domains, and closes; the post page shows the reply at once, as
text, if the message came from that window on `https://gwei.domains` and is for its post. That
addressing only narrows who learns which browser sent a reply: anyone can authorize any post hash on
their own name, open the window with that name (it then credits them), and hear back.

Replies are found from the room addresses. Until Glamsterdam's EIP-7708 gives ETH transfers a log,
that takes a tracing node: the gateway runs `trace_filter` (`toAddress`: the rooms) on the owner's
Erigon, and without it shows no new replies. Internal calls to a room are traced too, with their input,
so a range whose answer is too big or too slow is split, and a single block that still fails is read
from its transactions, which is all a reply can be. Each sync has a budget of calls, scans new blocks
for every room before rooms catch up on old ones, and keeps its progress block by block; a block that
can't be read at all is skipped after three tries. So no transaction can stop the index. The gateway shows a post's newest 500
replies.

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
| `GET /api/posts?after=<seq>&limit=<n>` | every post a blob carries, in the order the index found them, with their CIDs: `{ "posts", "next" }`. Pass `next` back as `after` to read on; a post found later always comes after it, so polling sees each once. Nothing is filtered by the validity rules |
| `GET /api/posts/<hash>` | the post, its CID, its authorizations, and where it is on Ethereum (with the blob's CID) |
| `GET /api/posts/<hash>/raw` | the exact post bytes |
| `GET /api/posts/<hash>/replies` | `{ "room", "replies" }`: every reply sent to the post's room, oldest first, each with its sender's `name` and its `system` (`gns`, `wns`, `ens`, or both `null`), whether or not the post shows them |
| `GET /api/names/<tokenId>/posts` | posts shown for a name, newest first |
| `GET /api/authors/<address>/paid` | fees an address put in escrow, latest per blob and publisher (to find refunds; the contract says what is left) |
| `GET /api/posts/recent` | newest posts across all names |
| `GET /api/blobs/<versionedHash>` | a blob the index fetched that carries a post, kept for good |
| `POST /api/posts/preview` (body: post bytes) | `{ "title", "html" }` rendered by the gateway |
| `POST /api/sync` | asks the index to catch up now (at most every 10 seconds) |

The index reads events every minute from the owner's node, or, when it's down, only events two
public RPCs agree on. It fetches the blobs that claim an authorized post (those sent by the
publisher the author named first) from Blobscan or a public beacon API, takes only bytes whose KZG
commitment matches the versioned hash, and records only the claimed entries a blob really contains.
A claim that arrives after its blob was checked gets the blob checked again, so an early junk claim
can't hide a later real one. A blob no source has any more is rebuilt from a post it should carry
(the index's copy, or IPFS through the gateways in `IPFS_GATEWAYS`) and checked against its versioned
hash. Posts carried by a blob, and their blobs, are kept for good. Posts show on a name's page when it has
no website set, at `https://<name>.gwei.domains/posts/…`, with an Atom feed at `/feed.xml`. A post's page
shows its replies and a reply box (Replies, above). Post pages themselves never ask for a wallet.

**Publisher.** The gwei.domains publisher (`posts/poster/`) delivers blobs authors paid it for. It
rebuilds each blob from the post's bytes (`GET /api/posts/<hash>/raw`) and checks its versioned hash
is the one the author named; when several posts claim the same blob it tries each, so a wrong claim
can't block the right one. It counts as paid only the deposits for a blob that can't be refunded for
at least six more hours, sends a blob only if those cover sending it alone at current prices with some
headroom, packs up to six blobs into one transaction, and never lets a transaction spend more than its
blobs' safe deposits, replacements included. The dapp pays three times the current cost of a one-blob
transaction. The publisher waits three blocks before acting on a payment and pins every published blob
that carries an authorized post to IPFS after checking it against its versioned hash with KZG.

**Mirror.** The same IPFS node runs `gwei-mirror`, so every post is also pinned under its own CID, and
serves both at `https://ipfs.slopo.net/ipfs/<cid>`.
