import { describe, expect, it } from "vitest";
import { buildNip51PrivateItems, extractNip51PrivateContacts } from "./nip51Contacts";
import type { Contact } from "./contacts";

const PUBKEY = "a".repeat(64);

function contact(overrides: Partial<Contact>): Contact {
  return {
    id: "c1",
    kind: "nostr",
    name: "",
    address: "",
    paymentRequest: "",
    npub: PUBKEY,
    ...overrides,
  } as Contact;
}

describe("NIP-51 private contact items", () => {
  it("writes a name without a relay hint at the standard petname position", () => {
    // NIP-51 p tags are ["p", pubkey, relay, petname]; iOS and the CLI read the petname at index 3.
    expect(buildNip51PrivateItems([contact({ name: "Alice" })])).toEqual([["p", PUBKEY, "", "Alice"]]);
  });

  it("writes relay and name, relay only, and bare keys", () => {
    expect(
      buildNip51PrivateItems([
        contact({ name: "Bob", relays: ["wss://relay.example"] }),
        contact({ id: "c2", npub: "b".repeat(64), relays: ["wss://relay.example"] }),
        contact({ id: "c3", npub: "c".repeat(64) }),
      ]),
    ).toEqual([
      ["p", PUBKEY, "wss://relay.example", "Bob"],
      ["p", "b".repeat(64), "wss://relay.example"],
      ["p", "c".repeat(64)],
    ]);
  });

  it("round-trips names, and still reads lists earlier PWA builds wrote with an extra empty field", () => {
    expect(extractNip51PrivateContacts(buildNip51PrivateItems([contact({ name: "Alice" })]))).toEqual([
      { pubkey: PUBKEY, relayHint: undefined, petname: "Alice" },
    ]);
    expect(extractNip51PrivateContacts([["p", PUBKEY, "", "", "Alice"]])).toEqual([
      { pubkey: PUBKEY, relayHint: undefined, petname: "Alice" },
    ]);
  });
});
