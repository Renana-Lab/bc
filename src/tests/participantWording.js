// Scanner for the participant-visible text of a rendered page (market-parity wording rules).
// jsdom has no innerText, so textContent plus the title, aria-label and alt attributes stand in for it.
export const FORBIDDEN_WORDING = /blockchain|cryptocurrency|\bwei\b|metamask|ethereum|sapphire|\bgas\b|\bwallet\b/i;
const FULL_ADDRESS = /0x[0-9a-fA-F]{40}/;

const attributeStrings = (root, names) =>
  Array.from(root.querySelectorAll(names.map((name) => `[${name}]`).join(","))).flatMap((el) =>
    names.map((name) => el.getAttribute(name)).filter(Boolean),
  );

const strip = (text, allow) => allow.reduce((rest, entry) => rest.split(entry).join(""), text);

// `allow`: exact legitimate strings (for example the admin-only "Switch back to participant wallet" item).
// Full addresses are tolerated only inside `title` attributes (the shortened text carries the full value there).
export const scanParticipantView = (root, { allow = [] } = {}) => {
  const texts = [root.textContent || "", ...attributeStrings(root, ["title", "aria-label", "alt"])];
  const words = texts.map((text) => strip(text, allow).match(FORBIDDEN_WORDING)?.[0]).filter(Boolean);
  const visible = [root.textContent || "", ...attributeStrings(root, ["aria-label", "alt"])];
  const addresses = visible.flatMap((text) => text.match(new RegExp(FULL_ADDRESS, "g")) || []);
  return { words, addresses };
};
