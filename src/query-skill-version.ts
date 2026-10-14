export const HASH_SHOWN = 8;

export const UNKNOWN_PART = "-";

type Loaded = { readonly skill: string; readonly bodySha256: string | null; readonly install: string | null };

const hashShown = (load: Loaded): string => load.bodySha256?.slice(0, HASH_SHOWN) ?? UNKNOWN_PART;

export const versionOf = (load: Loaded): string => `${hashShown(load)}/${load.install ?? UNKNOWN_PART}`;

export const bodyVersion = (load: Loaded): string => `${load.skill} ${hashShown(load)}`;
