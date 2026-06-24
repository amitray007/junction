// SPDX-License-Identifier: AGPL-3.0-only
// ID generators — the SINGLE ulid↔uuid swap point.
// If the project ever moves from ULID to UUID v7 (or any other format),
// change only this file. Nothing else generates IDs.
//
// Dependency direction: ids → schema (one-way, no cycle).
// schema must NOT import ids.

import { ulid } from "ulid"

import {
  type CredentialId,
  CredentialIdSchema,
  type PlatformId,
  PlatformIdSchema,
  type ProfileId,
  ProfileIdSchema,
} from "../schema/primitives.js"

/** Generate a new opaque PlatformId backed by a ULID. */
export function newPlatformId(): PlatformId {
  // THIS IS THE SINGLE ulid↔uuid SWAP POINT — change format here only.
  return PlatformIdSchema.parse(ulid())
}

/** Generate a new opaque CredentialId backed by a ULID. */
export function newCredentialId(): CredentialId {
  // THIS IS THE SINGLE ulid↔uuid SWAP POINT — change format here only.
  return CredentialIdSchema.parse(ulid())
}

/** Generate a new opaque ProfileId backed by a ULID. */
export function newProfileId(): ProfileId {
  // THIS IS THE SINGLE ulid↔uuid SWAP POINT — change format here only.
  return ProfileIdSchema.parse(ulid())
}
