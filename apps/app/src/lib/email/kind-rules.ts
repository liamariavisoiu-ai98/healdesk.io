import { DIRECT_KIND_REGISTRY, type DirectKind } from "./direct-kinds";
import {
  NOTICE_KIND_REGISTRY,
  type NoticeClass,
  type NoticeKind,
  type NoticeSwitch,
} from "./kinds";

/**
 * Every kind of email apps/app sends: an outbox kind (kinds.ts) or a direct
 * one (direct-kinds.ts). The two registries stay the sources of truth; this
 * file only answers the questions the sender, the lints and the webhook relay
 * ask of a kind, so none of them reads a registry its own way.
 */
export type EmailKind = NoticeKind | DirectKind;

/** A kind name as it may appear in a tag, a template file and an idempotency key. */
export const KIND_SHAPE = /^[a-z0-9_]{1,64}$/;

export function isNoticeKind(value: string): value is NoticeKind {
  return Object.prototype.hasOwnProperty.call(NOTICE_KIND_REGISTRY, value);
}

export function isDirectKind(value: string): value is DirectKind {
  return Object.prototype.hasOwnProperty.call(DIRECT_KIND_REGISTRY, value);
}

export function isEmailKind(value: string): value is EmailKind {
  return isNoticeKind(value) || isDirectKind(value);
}

/** CAN-SPAM's class (X1.10). */
export function classOf(kind: EmailKind): NoticeClass {
  return isNoticeKind(kind) ? NOTICE_KIND_REGISTRY[kind].class : DIRECT_KIND_REGISTRY[kind].class;
}

/** The switch that can stop it, if it is optional. Direct kinds are all part of the service. */
export function optionalSwitchOf(kind: EmailKind): NoticeSwitch | null {
  return isNoticeKind(kind) ? NOTICE_KIND_REGISTRY[kind].optionalSwitch : null;
}

/**
 * Whether it carries the one-click way to stop it (List-Unsubscribe and the
 * footer link): every optional kind and every commercial one.
 */
export function carriesUnsubscribe(kind: EmailKind): boolean {
  return optionalSwitchOf(kind) !== null || classOf(kind) === "commercial";
}

/**
 * Whether a single-use token may appear in it (X1.5). Never an outbox kind:
 * the outbox stores its payloads, and a token is minted at send time and never
 * stored.
 */
export function isLinkEmail(kind: EmailKind): boolean {
  return isDirectKind(kind) && DIRECT_KIND_REGISTRY[kind].linkEmail;
}

/** A clinic-less kind whose failure to arrive locks a clinic out of its account. */
export function locksOutClinic(kind: string): boolean {
  return isDirectKind(kind) && DIRECT_KIND_REGISTRY[kind].locksOut;
}

/** Critical kinds go in-process right after commit and turn /api/health red when late. */
export function isCriticalNotice(kind: NoticeKind): boolean {
  return NOTICE_KIND_REGISTRY[kind].priority === "critical";
}

export const CRITICAL_NOTICE_KINDS = (Object.keys(NOTICE_KIND_REGISTRY) as NoticeKind[]).filter(
  isCriticalNotice,
);
