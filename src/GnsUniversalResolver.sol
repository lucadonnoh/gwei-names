// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev The one NameNFT function the resolver calls by name. Forward resolution
///      calls are forwarded verbatim via staticcall instead (see `resolve`).
interface INameNFT {
    function reverseResolve(address addr) external view returns (string memory);
}

/// @title GnsUniversalResolver
/// @notice ENS "universal resolver" front-end for the Gwei Name Service (GNS).
///
///         Modern ENS client libraries (viem's `getEnsAddress` / `getEnsName` / `getEnsAvatar`,
///         and everything built on them: wagmi, wallets like Ambire) no longer call resolver
///         contracts directly. They speak to a single router contract, the "universal resolver",
///         through `resolveWithGateways(...)` and `reverseWithGateways(...)`. NameNFT implements
///         the ENS resolver profile (`addr(bytes32)`, `text(bytes32,string)`,
///         `contenthash(bytes32)`) but not that router interface, so those libraries cannot
///         query it as-is.
///
///         This contract is the missing router: a stateless adapter that lets any viem-based app
///         resolve `.gwei` names by passing one option:
///
///             client.getEnsAddress({ name: 'alice.gwei', universalResolverAddress: RESOLVER })
///             client.getEnsName({ address: who, universalResolverAddress: RESOLVER })
///             client.getEnsAvatar({ name: 'alice.gwei', universalResolverAddress: RESOLVER })
///
///         Unlike the ENS universal resolver there is no registry walk, no wildcard search, and
///         no CCIP-read: GNS keys every record by namehash in a single contract. Forward calls
///         are forwarded verbatim (the node is already inside `data`); reverse calls wrap
///         `reverseResolve`, which checks on-chain that the name still resolves back to the
///         queried address.
///
///         "Not found" is signalled the way NameNFT signals it, with empty or zero return values
///         (which viem maps to `null`), never with a revert. Integrators need no error handling
///         for missing names, expired names, or addresses without a primary name.
///
///         Like the rest of GNS this contract is ownerless and immutable: no owner, no admin,
///         no fees, no state.
contract GnsUniversalResolver {
    /*//////////////////////////////////////////////////////////////
                                   ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A forwarded resolver-profile call reverted in NameNFT. Mirrors the canonical
    ///         universal resolver's error, which client libraries already recognize.
    error ResolverError(bytes errorData);

    /// @notice `name` is not a valid DNS-encoded name. Mirrors the canonical error.
    error DNSDecodingFailed(bytes dns);

    /*//////////////////////////////////////////////////////////////
                                  STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The NameNFT contract every query is answered from.
    INameNFT public immutable gns;

    constructor(INameNFT gns_) {
        gns = gns_;
    }

    /*//////////////////////////////////////////////////////////////
                            FORWARD RESOLUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice ENSIP-10 style resolution: forwards `data` (an ABI-encoded resolver-profile call
    ///         such as `addr(bytes32)`, `addr(bytes32,uint256)`, `text(bytes32,string)`, or
    ///         `contenthash(bytes32)`) to NameNFT and returns the raw answer.
    /// @dev    The DNS-encoded name (first parameter) is not consulted: the namehash inside
    ///         `data` is authoritative, and NameNFT only holds nodes under `.gwei` anyway.
    ///         Unregistered and expired names yield zero/empty values from NameNFT, not reverts.
    /// @return result The raw return data of the profile call.
    /// @return resolver The resolver that answered (always NameNFT).
    function resolve(bytes calldata, bytes calldata data)
        public
        view
        returns (bytes memory result, address resolver)
    {
        bool ok;
        (ok, result) = address(gns).staticcall(data);
        if (!ok) revert ResolverError(result);
        return (result, address(gns));
    }

    /// @notice viem entry point (viem >= 2.23). Gateways are ignored: GNS is fully on-chain,
    ///         so there is never a CCIP-read round trip.
    function resolveWithGateways(bytes calldata name, bytes calldata data, string[] calldata)
        external
        view
        returns (bytes memory, address)
    {
        return resolve(name, data);
    }

    /*//////////////////////////////////////////////////////////////
                            REVERSE RESOLUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Reverse resolution: the primary name of an EVM address.
    /// @param lookupAddress The address as raw bytes (20 bytes).
    /// @param coinType SLIP-44 coin type; GNS stores primary names for ETH (60) only.
    /// @return name The primary name, e.g. "alice.gwei". Empty when the address has no primary
    ///              name, the name expired, the name no longer resolves back to the address
    ///              (checked by NameNFT), the coin type is not 60, or `lookupAddress` is not
    ///              20 bytes.
    /// @return resolver The forward resolver for the returned name (NameNFT; zero when empty).
    /// @return reverseResolver The reverse data source (NameNFT; zero when empty).
    function reverse(bytes calldata lookupAddress, uint256 coinType)
        public
        view
        returns (string memory name, address resolver, address reverseResolver)
    {
        if (coinType != 60 || lookupAddress.length != 20) return ("", address(0), address(0));
        name = gns.reverseResolve(address(bytes20(lookupAddress[:20])));
        if (bytes(name).length == 0) return ("", address(0), address(0));
        return (name, address(gns), address(gns));
    }

    /// @notice viem entry point (viem >= 2.23). Gateways are ignored (no CCIP-read).
    function reverseWithGateways(bytes calldata lookupAddress, uint256 coinType, string[] calldata)
        external
        view
        returns (string memory, address, address)
    {
        return reverse(lookupAddress, coinType);
    }

    /*//////////////////////////////////////////////////////////////
                                 DISCOVERY
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the resolver responsible for a DNS-encoded name; used by viem's
    ///         `getEnsResolver`. Always NameNFT (GNS has a single resolver for every node).
    /// @return resolver NameNFT.
    /// @return node The EIP-137 namehash of the name.
    /// @return offset Byte offset in `name` where the resolver was found (always 0: exact
    ///         match, no wildcard walk).
    function findResolver(bytes calldata name)
        external
        view
        returns (address resolver, bytes32 node, uint256 offset)
    {
        return (address(gns), _namehash(name, 0), 0);
    }

    /// @dev Computes the EIP-137 namehash from a DNS-encoded (length-prefixed, zero-terminated)
    ///      name, e.g. 0x05 "alice" 0x04 "gwei" 0x00 for "alice.gwei".
    function _namehash(bytes calldata name, uint256 pos) internal pure returns (bytes32) {
        if (pos >= name.length) revert DNSDecodingFailed(name);
        uint256 len = uint8(name[pos]);
        if (len == 0) {
            // Terminator must be the last byte.
            if (pos != name.length - 1) revert DNSDecodingFailed(name);
            return bytes32(0);
        }
        uint256 next = pos + 1 + len;
        // The label must fit and still leave room for the terminator.
        if (next >= name.length) revert DNSDecodingFailed(name);
        return keccak256(abi.encodePacked(_namehash(name, next), keccak256(name[pos + 1:next])));
    }
}
