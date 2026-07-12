use serde::{Deserialize, Serialize};
use vodozemac::{
    Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature,
    olm::{Account, AccountPickle, OlmMessage, Session, SessionConfig, SessionPickle},
};
use wasm_bindgen::prelude::*;

const PICKLE_KEY_LENGTH: usize = 32;

#[derive(Debug, Serialize, Deserialize)]
struct AccountState {
    pickle: String,
    ed25519: String,
    curve25519: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OneTimeKeyResult {
    account_pickle: String,
    one_time_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OutboundResult {
    session_pickle: String,
    session_id: String,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct InboundResult {
    account_pickle: String,
    session_pickle: String,
    session_id: String,
    plaintext: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionResult {
    session_pickle: String,
    plaintext: Option<String>,
    message: Option<String>,
}

fn err(context: &str, error: impl std::fmt::Debug) -> String {
    format!("{context}: {error:?}")
}

fn pickle_key(bytes: &[u8]) -> Result<[u8; PICKLE_KEY_LENGTH], String> {
    bytes.try_into().map_err(|_| {
        format!(
            "pickle key must be exactly {PICKLE_KEY_LENGTH} bytes, got {}",
            bytes.len()
        )
    })
}

fn load_account(ciphertext: &str, key: &[u8]) -> Result<Account, String> {
    let key = pickle_key(key)?;
    let pickle = AccountPickle::from_encrypted(ciphertext, &key)
        .map_err(|error| err("invalid account pickle", error))?;
    Ok(Account::from_pickle(pickle))
}

fn save_account(account: &Account, key: &[u8]) -> Result<String, String> {
    let key = pickle_key(key)?;
    Ok(account.pickle().encrypt(&key))
}

fn load_session(ciphertext: &str, key: &[u8]) -> Result<Session, String> {
    let key = pickle_key(key)?;
    let pickle = SessionPickle::from_encrypted(ciphertext, &key)
        .map_err(|error| err("invalid session pickle", error))?;
    Ok(Session::from_pickle(pickle))
}

fn save_session(session: &Session, key: &[u8]) -> Result<String, String> {
    let key = pickle_key(key)?;
    Ok(session.pickle().encrypt(&key))
}

fn encode<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| err("could not encode result", error))
}

fn decode_message(message: &str) -> Result<OlmMessage, String> {
    serde_json::from_str(message).map_err(|error| err("invalid Olm message", error))
}

fn new_account_inner(key: &[u8]) -> Result<AccountState, String> {
    let account = Account::new();
    let identity = account.identity_keys();
    Ok(AccountState {
        pickle: save_account(&account, key)?,
        ed25519: identity.ed25519.to_base64(),
        curve25519: identity.curve25519.to_base64(),
    })
}

fn generate_one_time_key_inner(
    account_pickle: &str,
    key: &[u8],
) -> Result<OneTimeKeyResult, String> {
    let mut account = load_account(account_pickle, key)?;
    let generated = account.generate_one_time_keys(1);
    let one_time_key = generated
        .created
        .into_iter()
        .next()
        .ok_or_else(|| "vodozemac did not generate a one-time key".to_owned())?;
    account.mark_keys_as_published();
    Ok(OneTimeKeyResult {
        account_pickle: save_account(&account, key)?,
        one_time_key: one_time_key.to_base64(),
    })
}

fn discard_one_time_key_inner(
    account_pickle: &str,
    key: &[u8],
    one_time_key: &str,
) -> Result<String, String> {
    let mut account = load_account(account_pickle, key)?;
    let one_time_key = Curve25519PublicKey::from_base64(one_time_key)
        .map_err(|error| err("invalid one-time key", error))?;
    account
        .remove_one_time_key(one_time_key)
        .ok_or_else(|| "one-time key is not stored by this account".to_owned())?;
    save_account(&account, key)
}

fn create_outbound_inner(
    account_pickle: &str,
    key: &[u8],
    their_identity_key: &str,
    their_one_time_key: &str,
    plaintext: &str,
) -> Result<OutboundResult, String> {
    let account = load_account(account_pickle, key)?;
    let identity_key = Curve25519PublicKey::from_base64(their_identity_key)
        .map_err(|error| err("invalid recipient identity key", error))?;
    let one_time_key = Curve25519PublicKey::from_base64(their_one_time_key)
        .map_err(|error| err("invalid recipient one-time key", error))?;

    let mut session = account
        .create_outbound_session(SessionConfig::version_1(), identity_key, one_time_key)
        .map_err(|error| err("could not create outbound session", error))?;
    let message = session
        .encrypt(plaintext.as_bytes())
        .map_err(|error| err("could not encrypt initial message", error))?;

    Ok(OutboundResult {
        session_pickle: save_session(&session, key)?,
        session_id: session.session_id(),
        message: encode(&message)?,
    })
}

fn create_inbound_inner(
    account_pickle: &str,
    key: &[u8],
    their_identity_key: &str,
    expected_one_time_key: &str,
    message: &str,
) -> Result<InboundResult, String> {
    let mut account = load_account(account_pickle, key)?;
    let identity_key = Curve25519PublicKey::from_base64(their_identity_key)
        .map_err(|error| err("invalid sender identity key", error))?;
    let message = decode_message(message)?;
    let pre_key_message = match &message {
        OlmMessage::PreKey(message) => message,
        OlmMessage::Normal(_) => return Err("initial message is not an Olm pre-key message".into()),
    };
    let expected_one_time_key = Curve25519PublicKey::from_base64(expected_one_time_key)
        .map_err(|error| err("invalid expected one-time key", error))?;
    if pre_key_message.one_time_key() != expected_one_time_key {
        return Err("initial message did not use the offered one-time key".into());
    }

    let result = account
        .create_inbound_session(SessionConfig::version_1(), identity_key, pre_key_message)
        .map_err(|error| err("could not create inbound session", error))?;
    let plaintext = String::from_utf8(result.plaintext)
        .map_err(|error| err("initial plaintext is not UTF-8", error))?;

    Ok(InboundResult {
        account_pickle: save_account(&account, key)?,
        session_pickle: save_session(&result.session, key)?,
        session_id: result.session.session_id(),
        plaintext,
    })
}

fn session_encrypt_inner(
    session_pickle: &str,
    key: &[u8],
    plaintext: &str,
) -> Result<SessionResult, String> {
    let mut session = load_session(session_pickle, key)?;
    let message = session
        .encrypt(plaintext.as_bytes())
        .map_err(|error| err("could not encrypt message", error))?;
    Ok(SessionResult {
        session_pickle: save_session(&session, key)?,
        plaintext: None,
        message: Some(encode(&message)?),
    })
}

fn session_decrypt_inner(
    session_pickle: &str,
    key: &[u8],
    message: &str,
) -> Result<SessionResult, String> {
    let mut session = load_session(session_pickle, key)?;
    let message = decode_message(message)?;
    let plaintext = session
        .decrypt(&message)
        .map_err(|error| err("could not decrypt message", error))?;
    let plaintext =
        String::from_utf8(plaintext).map_err(|error| err("plaintext is not UTF-8", error))?;
    Ok(SessionResult {
        session_pickle: save_session(&session, key)?,
        plaintext: Some(plaintext),
        message: None,
    })
}

fn js_result<T: Serialize>(result: Result<T, String>) -> Result<String, JsError> {
    result
        .and_then(|value| encode(&value))
        .map_err(|message| JsError::new(&message))
}

#[wasm_bindgen(js_name = newAccount)]
pub fn new_account(key: &[u8]) -> Result<String, JsError> {
    js_result(new_account_inner(key))
}

#[wasm_bindgen(js_name = generateOneTimeKey)]
pub fn generate_one_time_key(account_pickle: &str, key: &[u8]) -> Result<String, JsError> {
    js_result(generate_one_time_key_inner(account_pickle, key))
}

#[wasm_bindgen(js_name = discardOneTimeKey)]
pub fn discard_one_time_key(
    account_pickle: &str,
    key: &[u8],
    one_time_key: &str,
) -> Result<String, JsError> {
    discard_one_time_key_inner(account_pickle, key, one_time_key)
        .map_err(|message| JsError::new(&message))
}

#[wasm_bindgen(js_name = signManifest)]
pub fn sign_manifest(account_pickle: &str, key: &[u8], manifest: &str) -> Result<String, JsError> {
    let account = load_account(account_pickle, key).map_err(|message| JsError::new(&message))?;
    Ok(account.sign(manifest.as_bytes()).to_base64())
}

#[wasm_bindgen(js_name = verifyManifest)]
pub fn verify_manifest(public_key: &str, manifest: &str, signature: &str) -> Result<bool, JsError> {
    let public_key = Ed25519PublicKey::from_base64(public_key)
        .map_err(|error| JsError::new(&err("invalid signing key", error)))?;
    let signature = Ed25519Signature::from_base64(signature)
        .map_err(|error| JsError::new(&err("invalid signature", error)))?;
    Ok(public_key.verify(manifest.as_bytes(), &signature).is_ok())
}

#[wasm_bindgen(js_name = createOutbound)]
pub fn create_outbound(
    account_pickle: &str,
    key: &[u8],
    their_identity_key: &str,
    their_one_time_key: &str,
    plaintext: &str,
) -> Result<String, JsError> {
    js_result(create_outbound_inner(
        account_pickle,
        key,
        their_identity_key,
        their_one_time_key,
        plaintext,
    ))
}

#[wasm_bindgen(js_name = createInbound)]
pub fn create_inbound(
    account_pickle: &str,
    key: &[u8],
    their_identity_key: &str,
    expected_one_time_key: &str,
    message: &str,
) -> Result<String, JsError> {
    js_result(create_inbound_inner(
        account_pickle,
        key,
        their_identity_key,
        expected_one_time_key,
        message,
    ))
}

#[wasm_bindgen(js_name = sessionEncrypt)]
pub fn session_encrypt(
    session_pickle: &str,
    key: &[u8],
    plaintext: &str,
) -> Result<String, JsError> {
    js_result(session_encrypt_inner(session_pickle, key, plaintext))
}

#[wasm_bindgen(js_name = sessionDecrypt)]
pub fn session_decrypt(session_pickle: &str, key: &[u8], message: &str) -> Result<String, JsError> {
    js_result(session_decrypt_inner(session_pickle, key, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE_KEY: [u8; 32] = [0xA1; 32];
    const BOB_KEY: [u8; 32] = [0xB2; 32];
    const CAROL_KEY: [u8; 32] = [0xC3; 32];

    #[test]
    fn one_time_session_survives_pickle_roundtrips_and_reordering() {
        let alice = new_account_inner(&ALICE_KEY).unwrap();
        let bob = new_account_inner(&BOB_KEY).unwrap();
        let bob_key = generate_one_time_key_inner(&bob.pickle, &BOB_KEY).unwrap();

        let alice_start = create_outbound_inner(
            &alice.pickle,
            &ALICE_KEY,
            &bob.curve25519,
            &bob_key.one_time_key,
            "hello bob",
        )
        .unwrap();
        let bob_start = create_inbound_inner(
            &bob_key.account_pickle,
            &BOB_KEY,
            &alice.curve25519,
            &bob_key.one_time_key,
            &alice_start.message,
        )
        .unwrap();

        assert_eq!(bob_start.plaintext, "hello bob");
        assert_eq!(alice_start.session_id, bob_start.session_id);

        let bob_reply =
            session_encrypt_inner(&bob_start.session_pickle, &BOB_KEY, "hello alice").unwrap();
        let alice_reply = session_decrypt_inner(
            &alice_start.session_pickle,
            &ALICE_KEY,
            bob_reply.message.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(alice_reply.plaintext.as_deref(), Some("hello alice"));

        let first =
            session_encrypt_inner(&alice_reply.session_pickle, &ALICE_KEY, "first").unwrap();
        let second = session_encrypt_inner(&first.session_pickle, &ALICE_KEY, "second").unwrap();

        let received_second = session_decrypt_inner(
            &bob_reply.session_pickle,
            &BOB_KEY,
            second.message.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(received_second.plaintext.as_deref(), Some("second"));

        let received_first = session_decrypt_inner(
            &received_second.session_pickle,
            &BOB_KEY,
            first.message.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(received_first.plaintext.as_deref(), Some("first"));
    }

    #[test]
    fn every_session_uses_a_distinct_one_time_key() {
        let alice = new_account_inner(&ALICE_KEY).unwrap();
        let bob = new_account_inner(&BOB_KEY).unwrap();
        let carol = new_account_inner(&CAROL_KEY).unwrap();
        let first_key = generate_one_time_key_inner(&bob.pickle, &BOB_KEY).unwrap();
        let second_key = generate_one_time_key_inner(&first_key.account_pickle, &BOB_KEY).unwrap();
        assert_ne!(first_key.one_time_key, second_key.one_time_key);

        let alice_start = create_outbound_inner(
            &alice.pickle,
            &ALICE_KEY,
            &bob.curve25519,
            &first_key.one_time_key,
            "from alice",
        )
        .unwrap();
        let bob_after_alice = create_inbound_inner(
            &second_key.account_pickle,
            &BOB_KEY,
            &alice.curve25519,
            &first_key.one_time_key,
            &alice_start.message,
        )
        .unwrap();

        let carol_start = create_outbound_inner(
            &carol.pickle,
            &CAROL_KEY,
            &bob.curve25519,
            &second_key.one_time_key,
            "from carol",
        )
        .unwrap();
        let bob_after_carol = create_inbound_inner(
            &bob_after_alice.account_pickle,
            &BOB_KEY,
            &carol.curve25519,
            &second_key.one_time_key,
            &carol_start.message,
        )
        .unwrap();

        assert_eq!(bob_after_alice.plaintext, "from alice");
        assert_eq!(bob_after_carol.plaintext, "from carol");
    }

    #[test]
    fn mismatched_offer_does_not_consume_a_one_time_key() {
        let alice = new_account_inner(&ALICE_KEY).unwrap();
        let bob = new_account_inner(&BOB_KEY).unwrap();
        let first_key = generate_one_time_key_inner(&bob.pickle, &BOB_KEY).unwrap();
        let second_key = generate_one_time_key_inner(&first_key.account_pickle, &BOB_KEY).unwrap();
        let alice_start = create_outbound_inner(
            &alice.pickle,
            &ALICE_KEY,
            &bob.curve25519,
            &first_key.one_time_key,
            "bound to the first offer",
        )
        .unwrap();

        assert!(
            create_inbound_inner(
                &second_key.account_pickle,
                &BOB_KEY,
                &alice.curve25519,
                &second_key.one_time_key,
                &alice_start.message,
            )
            .is_err()
        );
        let accepted = create_inbound_inner(
            &second_key.account_pickle,
            &BOB_KEY,
            &alice.curve25519,
            &first_key.one_time_key,
            &alice_start.message,
        )
        .unwrap();
        assert_eq!(accepted.plaintext, "bound to the first offer");
    }

    #[test]
    fn unused_one_time_keys_can_be_discarded() {
        let bob = new_account_inner(&BOB_KEY).unwrap();
        let generated = generate_one_time_key_inner(&bob.pickle, &BOB_KEY).unwrap();
        let discarded = discard_one_time_key_inner(
            &generated.account_pickle,
            &BOB_KEY,
            &generated.one_time_key,
        )
        .unwrap();
        let account = load_account(&discarded, &BOB_KEY).unwrap();
        assert_eq!(account.stored_one_time_key_count(), 0);
    }

    #[test]
    fn manifest_signatures_roundtrip() {
        let alice = new_account_inner(&ALICE_KEY).unwrap();
        let account = load_account(&alice.pickle, &ALICE_KEY).unwrap();
        let manifest = r#"{"v":0,"delivery":"example"}"#;
        let signature = account.sign(manifest.as_bytes());
        let public_key = Ed25519PublicKey::from_base64(&alice.ed25519).unwrap();

        assert!(public_key.verify(manifest.as_bytes(), &signature).is_ok());
        assert!(public_key.verify(b"tampered", &signature).is_err());
    }
}
