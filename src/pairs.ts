import type { IOpenUser } from "@lark-base-open/js-sdk";

export interface Member {
  label: string;
  key?: string;
  user?: IOpenUser;
}

export interface NormalizedMember extends Member {
  key: string;
}

export function uniqueMembers(members: Member[]): NormalizedMember[] {
  const seen = new Map<string, NormalizedMember>();

  for (const member of members) {
    const label = member.label?.trim();
    if (!label) continue;

    const key = member.user?.id ? `user:${member.user.id}` : `label:${label.toLocaleLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { ...member, key, label });
  }

  return [...seen.values()];
}

export function pairKey(left: NormalizedMember, right: NormalizedMember): string {
  return left.key < right.key ? `${left.key}\u0000${right.key}` : `${right.key}\u0000${left.key}`;
}

export function missingPairs(
  members: NormalizedMember[],
  existingKeys: ReadonlySet<string> = new Set(),
): [NormalizedMember, NormalizedMember][] {
  const pairs: [NormalizedMember, NormalizedMember][] = [];

  for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
      const left = members[leftIndex];
      const right = members[rightIndex];
      if (left && right && !existingKeys.has(pairKey(left, right))) pairs.push([left, right]);
    }
  }

  return pairs;
}
