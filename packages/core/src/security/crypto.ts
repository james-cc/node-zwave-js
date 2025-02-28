import { Bytes } from "@zwave-js/shared/safe";
import * as crypto from "node:crypto";
import { leftShift1, xor, zeroPad } from "./bufferUtils.js";

function encrypt(
	algorithm: string,
	blockSize: number,
	trimToInputLength: boolean,
	input: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
): Uint8Array {
	const cipher = crypto.createCipheriv(algorithm, key, iv);
	cipher.setAutoPadding(false);

	const { output: plaintext, paddingLength } = zeroPad(input, blockSize);
	const ret = Bytes.concat([cipher.update(plaintext), cipher.final()]);

	if (trimToInputLength && paddingLength > 0) {
		return ret.subarray(0, -paddingLength);
	} else {
		return ret;
	}
}

function decrypt(
	algorithm: string,
	blockSize: number,
	trimToInputLength: boolean,
	input: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
): Uint8Array {
	const cipher = crypto.createDecipheriv(algorithm, key, iv);
	cipher.setAutoPadding(false);

	const { output: ciphertext, paddingLength } = zeroPad(input, blockSize);
	const ret = Bytes.concat([cipher.update(ciphertext), cipher.final()]);

	if (trimToInputLength && paddingLength > 0) {
		return ret.subarray(0, -paddingLength);
	} else {
		return ret;
	}
}

/** Encrypts a payload using AES-128-ECB (as described in SDS10865) */
export function encryptAES128ECB(
	plaintext: Uint8Array,
	key: Uint8Array,
): Uint8Array {
	return encrypt("aes-128-ecb", 16, false, plaintext, key, new Uint8Array());
}

/** Encrypts a payload using AES-OFB (as described in SDS10865) */
export const encryptAES128OFB = encrypt.bind(
	undefined,
	"aes-128-ofb",
	16,
	true,
);

/** Decrypts a payload using AES-OFB (as described in SDS10865) */
export const decryptAES128OFB = decrypt.bind(
	undefined,
	"aes-128-ofb",
	16,
	true,
);

/** Computes a message authentication code for Security S0 (as described in SDS10865) */
export function computeMAC(
	authData: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array = new Uint8Array(16).fill(0),
): Uint8Array {
	const ciphertext = encrypt("aes-128-cbc", 16, false, authData, key, iv);
	// The MAC is the first 8 bytes of the last 16 byte block
	return ciphertext.subarray(-16, -8);
}

/** Decodes a DER-encoded x25519 key (PKCS#8 or SPKI) */
export function decodeX25519KeyDER(key: Uint8Array): Uint8Array {
	// We could parse this with asn1js but that doesn't seem necessary for now
	return key.subarray(-32);
}

/** Encodes an x25519 key from a raw buffer with DER/PKCS#8 */
export function encodeX25519KeyDERPKCS8(key: Uint8Array): Uint8Array {
	// We could encode this with asn1js but that doesn't seem necessary for now
	return Bytes.concat([
		Bytes.from("302e020100300506032b656e04220420", "hex"),
		key,
	]);
}

/** Encodes an x25519 key from a raw buffer with DER/SPKI */
export function encodeX25519KeyDERSPKI(key: Uint8Array): Uint8Array {
	// We could encode this with asn1js but that doesn't seem necessary for now
	return Bytes.concat([Bytes.from("302a300506032b656e032100", "hex"), key]);
}

export interface KeyPair {
	publicKey: crypto.KeyObject;
	privateKey: crypto.KeyObject;
}

/** Generates an x25519 / ECDH key pair */
export function generateECDHKeyPair(): KeyPair {
	return crypto.generateKeyPairSync("x25519");
}

export function keyPairFromRawECDHPrivateKey(privateKey: Uint8Array): KeyPair {
	const privateKeyObject = importRawECDHPrivateKey(privateKey);
	const publicKeyObject = crypto.createPublicKey(privateKeyObject);
	return {
		privateKey: privateKeyObject,
		publicKey: publicKeyObject,
	};
}

/** Takes an ECDH public KeyObject and returns the raw key as a buffer */
export function extractRawECDHPublicKey(
	publicKey: crypto.KeyObject,
): Uint8Array {
	return decodeX25519KeyDER(
		publicKey.export({
			type: "spki",
			format: "der",
		}),
	);
}

/** Converts a raw public key to an ECDH KeyObject */
export function importRawECDHPublicKey(
	publicKey: Uint8Array,
): crypto.KeyObject {
	return crypto.createPublicKey({
		// eslint-disable-next-line no-restricted-globals -- crypto API requires Buffer instances
		key: Buffer.from(encodeX25519KeyDERSPKI(publicKey).buffer),
		format: "der",
		type: "spki",
	});
}

/** Takes an ECDH private KeyObject and returns the raw key as a buffer */
export function extractRawECDHPrivateKey(
	privateKey: crypto.KeyObject,
): Uint8Array {
	return decodeX25519KeyDER(
		privateKey.export({
			type: "pkcs8",
			format: "der",
		}),
	);
}

/** Converts a raw private key to an ECDH KeyObject */
export function importRawECDHPrivateKey(
	privateKey: Uint8Array,
): crypto.KeyObject {
	return crypto.createPrivateKey({
		// eslint-disable-next-line no-restricted-globals -- crypto API requires Buffer instances
		key: Buffer.from(encodeX25519KeyDERPKCS8(privateKey).buffer),
		format: "der",
		type: "pkcs8",
	});
}

// Decoding with asn1js for reference:
// const asn1 = require("asn1js");
// const public = asn1.fromBER(keypair.publicKey.buffer);
// const private = asn1.fromBER(keypair.privateKey.buffer);
// const privateKeyBER = private.result.valueBlock.value[2].valueBlock.valueHex;
// const privateKey = Buffer.from(
// 	asn1.fromBER(privateKeyBER).result.valueBlock.valueHex,
// );
// const publicKey = Buffer.from(
// 	public.result.valueBlock.value[1].valueBlock.valueHex,
// );

const Z128 = new Uint8Array(16).fill(0);
const R128 = Bytes.from("00000000000000000000000000000087", "hex");

function generateAES128CMACSubkeys(
	key: Uint8Array,
): [k1: Uint8Array, k2: Uint8Array] {
	// NIST SP 800-38B, chapter 6.1
	const L = encryptAES128ECB(Z128, key);
	const k1 = !(L[0] & 0x80) ? leftShift1(L) : xor(leftShift1(L), R128);
	const k2 = !(k1[0] & 0x80) ? leftShift1(k1) : xor(leftShift1(k1), R128);
	return [k1, k2];
}

/** Computes a message authentication code for Security S2 (as described in SDS13783) */
export function computeCMAC(message: Uint8Array, key: Uint8Array): Uint8Array {
	const blockSize = 16;
	const numBlocks = Math.ceil(message.length / blockSize);
	let lastBlock = message.subarray((numBlocks - 1) * blockSize);
	const lastBlockIsComplete = message.length > 0
		&& message.length % blockSize === 0;
	if (!lastBlockIsComplete) {
		lastBlock = zeroPad(
			Bytes.concat([lastBlock, Bytes.from([0x80])]),
			blockSize,
		).output;
	}

	// Compute all steps but the last one
	let ret = Z128;
	for (let i = 0; i < numBlocks - 1; i++) {
		ret = xor(ret, message.subarray(i * blockSize, (i + 1) * blockSize));
		ret = encryptAES128ECB(ret, key);
	}
	// Compute the last step
	const [k1, k2] = generateAES128CMACSubkeys(key);
	ret = xor(ret, xor(lastBlockIsComplete ? k1 : k2, lastBlock));
	ret = encryptAES128ECB(ret, key);

	return ret.subarray(0, blockSize);
}

const constantPRK = new Uint8Array(16).fill(0x33);

/** Computes the Pseudo Random Key (PRK) used to derive auth, encryption and nonce keys */
export function computePRK(
	ecdhSharedSecret: Uint8Array,
	pubKeyA: Uint8Array,
	pubKeyB: Uint8Array,
): Uint8Array {
	const message = Bytes.concat([ecdhSharedSecret, pubKeyA, pubKeyB]);
	return computeCMAC(message, constantPRK);
}

const constantTE = new Uint8Array(15).fill(0x88);

/** Derives the temporary auth, encryption and nonce keys from the PRK */
export function deriveTempKeys(PRK: Uint8Array): {
	tempKeyCCM: Uint8Array;
	tempPersonalizationString: Uint8Array;
} {
	const T1 = computeCMAC(
		Bytes.concat([constantTE, [0x01]]),
		PRK,
	);
	const T2 = computeCMAC(
		Bytes.concat([T1, constantTE, [0x02]]),
		PRK,
	);
	const T3 = computeCMAC(
		Bytes.concat([T2, constantTE, [0x03]]),
		PRK,
	);
	return {
		tempKeyCCM: T1,
		tempPersonalizationString: Bytes.concat([T2, T3]),
	};
}

const constantNK = new Uint8Array(15).fill(0x55);

/** Derives the CCM, MPAN keys and the personalization string from the permanent network key (PNK) */
export function deriveNetworkKeys(PNK: Uint8Array): {
	keyCCM: Uint8Array;
	keyMPAN: Uint8Array;
	personalizationString: Uint8Array;
} {
	const T1 = computeCMAC(
		Bytes.concat([constantNK, [0x01]]),
		PNK,
	);
	const T2 = computeCMAC(
		Bytes.concat([T1, constantNK, [0x02]]),
		PNK,
	);
	const T3 = computeCMAC(
		Bytes.concat([T2, constantNK, [0x03]]),
		PNK,
	);
	const T4 = computeCMAC(
		Bytes.concat([T3, constantNK, [0x04]]),
		PNK,
	);
	return {
		keyCCM: T1,
		keyMPAN: T4,
		personalizationString: Bytes.concat([T2, T3]),
	};
}

const constantNonce = new Uint8Array(16).fill(0x26);

/** Computes the Pseudo Random Key (PRK) used to derive the mixed entropy input (MEI) for nonce generation */
export function computeNoncePRK(
	senderEI: Uint8Array,
	receiverEI: Uint8Array,
): Uint8Array {
	const message = Bytes.concat([senderEI, receiverEI]);
	return computeCMAC(message, constantNonce);
}

const constantEI = new Uint8Array(15).fill(0x88);

/** Derives the MEI from the nonce PRK */
export function deriveMEI(noncePRK: Uint8Array): Uint8Array {
	const T1 = computeCMAC(
		Bytes.concat([
			constantEI,
			[0x00],
			constantEI,
			[0x01],
		]),
		noncePRK,
	);
	const T2 = computeCMAC(
		Bytes.concat([T1, constantEI, [0x02]]),
		noncePRK,
	);
	return Bytes.concat([T1, T2]);
}

export const SECURITY_S2_AUTH_TAG_LENGTH = 8;

export function encryptAES128CCM(
	key: Uint8Array,
	iv: Uint8Array,
	plaintext: Uint8Array,
	additionalData: Uint8Array,
	authTagLength: number,
): { ciphertext: Uint8Array; authTag: Uint8Array } {
	// prepare encryption
	const algorithm = `aes-128-ccm`;
	const cipher = crypto.createCipheriv(algorithm, key, iv, { authTagLength });
	cipher.setAAD(additionalData, { plaintextLength: plaintext.length });

	// do encryption
	const ciphertext = cipher.update(plaintext);
	cipher.final();
	const authTag = cipher.getAuthTag();

	return { ciphertext, authTag };
}

export function decryptAES128CCM(
	key: Uint8Array,
	iv: Uint8Array,
	ciphertext: Uint8Array,
	additionalData: Uint8Array,
	authTag: Uint8Array,
): { plaintext: Uint8Array; authOK: boolean } {
	// prepare decryption
	const algorithm = `aes-128-ccm`;
	const decipher = crypto.createDecipheriv(algorithm, key, iv, {
		authTagLength: authTag.length,
	});
	decipher.setAuthTag(authTag);
	decipher.setAAD(additionalData, { plaintextLength: ciphertext.length });

	// do decryption
	const plaintext = decipher.update(ciphertext);
	// verify decryption
	let authOK = false;
	try {
		decipher.final();
		authOK = true;
	} catch {
		/* nothing to do */
	}
	return { plaintext, authOK };
}
