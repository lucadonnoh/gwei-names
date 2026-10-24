# GNS posts

Posts are short documents (blog posts, notes, articles) published under a `.gwei` name. Their text
travels in EIP-4844 blobs, and a small ownerless contract records who vouched for what. Like the rest
of GNS, nothing here has an owner or an operator: anyone can publish, anyone can index, and every
publisher's posts count the same.

gwei.domains runs one publisher and one index, described at the end. Neither is special.

## Contract

`GnsPosts` ([src/GnsPosts.sol](../src/GnsPosts.sol)) has no owner, admin, storage or upgrades. It
checks name ownership against NameNFT (`0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6`) and emits
events. Clients rebuild everything from these events, with no archive state needed.

| Function | Who | Effect |
|---|---|---|
| `authorize(tokenId, postHash, publisher)` payable | owner of an active name | `PostAuthorized`; forwards `msg.value` to `publisher` |
| `publish(bytes32[][] postHashes)` | anyone, in a blob transaction | `PostPublished` for each hash, with `postHashes[i]` in blob `i` |
| `post(tokenId, postHash, blobIndex)` | owner, in a blob transaction | both events at once (self-publishing) |
| `remove(tokenId, postHash)` | owner | `PostRemoved` |

```
event PostAuthorized(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author, address publisher, uint256 fee);
event PostPublished(bytes32 indexed postHash, bytes32 indexed blobHash, address indexed publisher);
event PostRemoved(uint256 indexed tokenId, bytes32 indexed postHash, address indexed author);
```

`blobHash` is the blob's versioned hash, read on-chain with `BLOBHASH`, so it always names a blob
attached to the same transaction. Contract wallets, which can't send blobs, can still `authorize`.

## Post format

A post is a UTF-8 JSON object, at most 126,968 bytes:

```json
{"v":1,"title":"Exploring the blobspace","body":"Markdown text…","time":1667844963}
```

- `v`: `1`.
- `title`: a non-empty string of at most 200 characters.
- `body`: Markdown (below).
- `time`: optional, the date the author gives the post, in Unix seconds. Clients fall back to the
  block time of the authorization.
- Other fields are ignored, so later versions can add some.

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

One blob can carry many posts. A post must fit in a single blob.

## Validity

A client shows a post under name `N` (token `T`) when all of these hold:

1. `PostAuthorized(T, h, author, …)` was emitted, and `author` is `N`'s current owner. A sold name
   doesn't carry its previous owner's posts.
2. The client has bytes whose keccak-256 is `h` and that parse as a post. Where the bytes came from
   doesn't matter: a blob, an upload, a friend.
3. There is no `PostRemoved(T, h, author)` after `author`'s latest `PostAuthorized(T, h, …)`.

A post is **on Ethereum** when, additionally, a `PostPublished(h, blobHash, …)` names a blob whose
payload contains bytes hashing to `h`. A claim for a blob that doesn't contain the post is ignored.
Clients may show authorized posts that aren't on Ethereum yet, marked as pending. The gateway does
so for one day.

Blobs leave ordinary beacon nodes after about 18 days (4096 epochs). Indexers should fetch the blobs
that authorized posts point at well before then and keep them. Blob archives such as
[Blobscan](https://blobscan.com) keep them longer.

## Publishing

- **Yourself:** send a blob transaction from the name's owner calling `post(tokenId, postHash, 0)`
  with the post in blob 0. One transaction, no one else involved.
- **Through a publisher:** upload the bytes where publishers can read them, then call
  `authorize(tokenId, postHash, publisher)` with the publisher's fee. The publisher sends the blob
  and calls `publish`. If it doesn't, anyone else can: the bytes and the authorization are public.

## gwei.domains

**API.** The gateway serves its index at `https://gwei.domains/api`, readable from any origin:

| Request | Answer |
|---|---|
| `POST /api/posts` (body: post bytes) | `{ "hash" }`; anyone may upload. Bytes no owner authorizes are dropped after a day; bytes of an already-authorized hash are always accepted |
| `GET /api/posts/<hash>` | the post, its authorizations, and where it is on Ethereum |
| `GET /api/posts/<hash>/raw` | the exact post bytes |
| `GET /api/names/<tokenId>/posts` | posts shown for a name, newest first |
| `GET /api/posts/recent` | newest posts across all names |
| `GET /api/blobs/<versionedHash>` | a blob the index fetched, for 30 days after it did |
| `POST /api/posts/preview` (body: post bytes) | `{ "title", "html" }` rendered by the gateway |
| `POST /api/sync` | asks the index to catch up now (at most every 10 seconds) |

The index reads events every minute from the owner's node, or, when it's down, only events two
public RPCs agree on. It fetches the blobs that claim an authorized post (those sent by the
publisher the author named first) from Blobscan and a public beacon API, requiring the two to agree
when both have the blob, and records only the claimed entries a blob really contains. A post
carried by a blob is kept for good; blob bytes for 30 days. Posts show on a name's page when it has
no website set, at `https://<name>.gwei.domains/posts/…`, with an Atom feed at `/feed.xml`.

**Publisher.** The gwei.domains publisher (`posts/poster/`) carries any post authorized with its
address as `publisher` whose fee covers publishing that post alone at current prices, with some
headroom. Posts that pay that much are batched into shared blobs; posts that pay less wait until
prices fall, and never ride on other posts' fees. No transaction it sends can spend more than its
posts paid, replacements included. The dapp pays three times the current cost of a one-post
transaction. The publisher reads post bytes from `GET /api/posts/<hash>/raw`, waits three blocks
before acting on a payment, and pins every blob that carries an authorized post to IPFS after
checking it against its versioned hash with KZG.
