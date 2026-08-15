// Generated from src/NameNFT.sol by scripts/generate-abi.mjs. Do not edit by hand.
export const gnsAbi = [
  {
    type: 'function',
    name: 'GWEI_NODE',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'addr',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'addr',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'coinType',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'addr',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'coinType',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'id',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'result',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'commit',
    inputs: [
      {
        name: 'commitment',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'commitments',
    inputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'computeId',
    inputs: [
      {
        name: 'fullName',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'computeNamehash',
    inputs: [
      {
        name: 'fullName',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: 'node',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'contenthash',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'contenthash',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'expiresAt',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getApproved',
    inputs: [
      {
        name: 'id',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: 'result',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getFee',
    inputs: [
      {
        name: 'length',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'getFullName',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getPremium',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'inGracePeriod',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'operator',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'result',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isAsciiLabel',
    inputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'isAvailable',
    inputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'parentId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isExpired',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'makeCommitment',
    inputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'secret',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'name',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'normalize',
    inputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'ownerOf',
    inputs: [
      {
        name: 'id',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: 'result',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'primaryName',
    inputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'recordVersion',
    inputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'records',
    inputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'parent',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'expiresAt',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'epoch',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'parentEpoch',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'registerSubdomain',
    inputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'parentId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'registerSubdomainFor',
    inputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'parentId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'renew',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'resolve',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'reveal',
    inputs: [
      {
        name: 'label',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'secret',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'reverseResolve',
    inputs: [
      {
        name: 'addr',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'safeTransferFrom',
    inputs: [
      {
        name: 'from',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'id',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'safeTransferFrom',
    inputs: [
      {
        name: 'from',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'id',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'data',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'setAddr',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'addr',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setAddrForCoin',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'coinType',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'addr',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    inputs: [
      {
        name: 'operator',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'isApproved',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setContenthash',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'hash',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setPrimaryName',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setText',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'key',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'value',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'supportsInterface',
    inputs: [
      {
        name: 'interfaceId',
        type: 'bytes4',
        internalType: 'bytes4',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'text',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'key',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'text',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'key',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tokenURI',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'transferFrom',
    inputs: [
      {
        name: 'from',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'id',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'event',
    name: 'AddrChanged',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'addr',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AddressChanged',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'coinType',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'addr',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'id',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ApprovalForAll',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'operator',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'isApproved',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Committed',
    inputs: [
      {
        name: 'commitment',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'committer',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ContenthashChanged',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'contenthash',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'NameRegistered',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'label',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
      {
        name: 'owner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'expiresAt',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'NameRenewed',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'newExpiresAt',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PrimaryNameSet',
    inputs: [
      {
        name: 'addr',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'tokenId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SubdomainRegistered',
    inputs: [
      {
        name: 'tokenId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'parentId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'label',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TextChanged',
    inputs: [
      {
        name: 'node',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'key',
        type: 'string',
        indexed: true,
        internalType: 'string',
      },
      {
        name: 'value',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      {
        name: 'from',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'id',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'AccountBalanceOverflow',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AlreadyCommitted',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AlreadyRegistered',
    inputs: [],
  },
  {
    type: 'error',
    name: 'BalanceQueryForZeroAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'CommitmentNotFound',
    inputs: [],
  },
  {
    type: 'error',
    name: 'CommitmentTooNew',
    inputs: [],
  },
  {
    type: 'error',
    name: 'CommitmentTooOld',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EmptyLabel',
    inputs: [],
  },
  {
    type: 'error',
    name: 'Expired',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InsufficientFee',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidLength',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidName',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotOwnerNorApproved',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotParentOwner',
    inputs: [],
  },
  {
    type: 'error',
    name: 'Reentrancy',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TokenAlreadyExists',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TokenDoesNotExist',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TooDeep',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferFromIncorrectOwner',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferToNonERC721ReceiverImplementer',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferToZeroAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'Unauthorized',
    inputs: [],
  },
] as const
