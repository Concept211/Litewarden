// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addressProblem, guessNetwork, networkById, networkOfAddress, normalizeSeed, seedWords, shortAddress, walletOf, walletPart } from '../../src/core/wallet';
import { checkEvmAddress, checkKey, checkSeed, checksumAddress, evmAddressOf } from '../../src/shared/walletcheck';

// Well-known sample key and address (web3.js docs). Never holds funds.
const KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
// The BIP39 test vector: all zero entropy.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const f = (name: string, value: string | null, type = 0) => ({ name, value, type });

describe('spotting a wallet', () => {
  it('reads the standard names and the common other ones', () => {
    expect(walletPart('Public address')).toBe('address');
    expect(walletPart('Wallet Address')).toBe('address');
    expect(walletPart('Secret Recovery Phrase')).toBe('seed');
    expect(walletPart('mnemonic')).toBe('seed');
    expect(walletPart('Private key')).toBe('privateKey');
    expect(walletPart('Chain')).toBe('network');
    expect(walletPart('Seed phrase', 2)).toBeNull();
    expect(walletPart('PIN')).toBeNull();
  });

  it('a note with a key or phrase is a wallet, with its parts and where they are', () => {
    const w = walletOf([f('Member ID', '1'), f('Network', 'Hyperliquid'), f('Public address', ADDR), f('Private key', KEY, 1), f('Seed phrase', SEED, 1)]);
    expect(w).toMatchObject({ network: 'Hyperliquid', address: ADDR, privateKey: KEY, seed: SEED, at: { network: 1, address: 2, privateKey: 3, seed: 4 } });
  });

  it('a plain "Address" field only counts when it holds a crypto address', () => {
    expect(walletOf([f('Address', '120 Ocean Drive, Miami')])).toBeNull();
    expect(walletOf([f('Address', BTC)])?.address).toBe(BTC);
    expect(walletOf([f('Network', 'Bitcoin')])).toBeNull();
    expect(walletOf([])).toBeNull();
  });

  it('empty parts still make a wallet (a new one, or one with the key removed)', () => {
    expect(walletOf([f('Network', ''), f('Public address', ''), f('Private key', '', 1), f('Seed phrase', '', 1)])).not.toBeNull();
  });
});

describe('networks', () => {
  it('knows the network from the address format', () => {
    expect(networkOfAddress(ADDR)).toBe('ethereum');
    expect(networkOfAddress(BTC)).toBe('bitcoin');
    expect(networkOfAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('bitcoin');
    expect(networkOfAddress('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7')).toBe('tron');
    expect(networkOfAddress('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')).toBe('solana');
    expect(networkOfAddress('ltc1qg82tadd0d5yvf3wc8e8ae7ad5q4fakehjhwqfx')).toBe('litecoin');
    expect(networkOfAddress('hello')).toBeNull();
  });

  it('a hint in the name wins when it fits the address: a 0x address can be Hyperliquid', () => {
    expect(guessNetwork({ address: ADDR, name: 'Hyperliquid main' })).toEqual({ id: 'hyperliquid', from: 'name' });
    expect(guessNetwork({ address: ADDR, name: 'Trading' })).toEqual({ id: 'ethereum', from: 'address' });
    expect(guessNetwork({ address: ADDR, urls: ['https://app.hyperliquid.xyz/trade'] })).toEqual({ id: 'hyperliquid', from: 'site' });
    // A Bitcoin name can't turn a 0x address into Bitcoin.
    expect(guessNetwork({ address: ADDR, name: 'Bitcoin savings' })).toEqual({ id: 'ethereum', from: 'address' });
    expect(guessNetwork({ name: 'Cold storage' })).toBeNull();
    expect(guessNetwork({ name: 'Database login' })).toBeNull();
  });

  it('saved names map back to our networks, unknown ones stay as typed', () => {
    expect(networkById('Hyperliquid')?.id).toBe('hyperliquid');
    expect(networkById('BSC')?.id).toBe('bnb');
    expect(networkById('BNB Chain')?.id).toBe('bnb');
    expect(networkById('Kaspa')).toBeNull();
    expect(networkById(null)).toBeNull();
  });

  it('shortens addresses for the list', () => {
    expect(shortAddress(ADDR)).toBe('0x2c75…5c23');
    expect(shortAddress(BTC)).toBe('bc1qar…5mdq');
    expect(shortAddress('short')).toBe('short');
  });

  it('warns about a 0x address of the wrong length or a mismatched network', () => {
    const eth = networkById('Ethereum');
    expect(addressProblem(ADDR, eth)).toBeNull();
    expect(addressProblem(ADDR.slice(0, -2), eth)).toBe('This 0x address is 2 characters short.');
    expect(addressProblem(`${ADDR}a`, eth)).toBe('This 0x address is 1 character too long.');
    expect(addressProblem(BTC, eth)).toBe('Ethereum addresses start with 0x.');
    expect(addressProblem(ADDR, networkById('Bitcoin'))).toBe("This doesn't look like a Bitcoin address.");
    expect(addressProblem(BTC, networkById('Bitcoin'))).toBeNull();
    expect(addressProblem('', eth)).toBeNull();
  });
});

describe('seed phrases', () => {
  it('reads pasted phrases: new lines, commas and numbered lists', () => {
    expect(seedWords('1. Ripple 2. orbit\n3) canvas, 4 tunnel')).toEqual(['ripple', 'orbit', 'canvas', 'tunnel']);
    expect(normalizeSeed('  abandon\n\nabout ')).toBe('abandon about');
  });

  it('checks words, count and checksum, on this computer', () => {
    expect(checkSeed(SEED)).toEqual({ ok: '12 words, all on the standard list' });
    expect(checkSeed(SEED.replace('about', 'mapple'))).toEqual({ bad: 'Word 12, "mapple", isn\'t on the standard list.' });
    expect(checkSeed('abandon abandon abandon')).toEqual({ bad: 'Seed phrases have 12, 15, 18, 21 or 24 words. This one has 3.' });
    expect(checkSeed(SEED.replace('about', 'abandon'))).toMatchObject({ bad: expect.stringContaining("doesn't check out") });
    // Other languages aren't checked against the English list.
    expect(checkSeed('あいこくしん あいさつ')).toBeNull();
  });
});

describe('0x keys and addresses', () => {
  it('works out the address from the private key', () => {
    expect(evmAddressOf(KEY)).toBe(ADDR);
    expect(evmAddressOf(`0x${KEY}`)).toBe(ADDR);
    expect(evmAddressOf('xyz')).toBeNull();
    expect(checksumAddress(ADDR.toLowerCase())).toBe(ADDR);
  });

  it('says whether the key belongs to the address', () => {
    expect(checkKey(KEY, ADDR, true)).toEqual({ ok: 'Matches the address' });
    expect(checkKey(KEY, '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', true)).toEqual({ bad: 'This key belongs to 0x2c75…5c23, not this address.' });
    expect(checkKey('nope', ADDR, true)).toMatchObject({ bad: expect.stringContaining('64 characters') });
    expect(checkKey(KEY, BTC, false)).toBeNull();
  });

  it('catches a typo in a mixed-case address by its checksum', () => {
    expect(checkEvmAddress(ADDR)).toBeNull();
    expect(checkEvmAddress(ADDR.toLowerCase())).toBeNull();
    expect(checkEvmAddress(ADDR.replace('E36', 'e36'))).toMatchObject({ bad: expect.stringContaining('checksum') });
  });
});
