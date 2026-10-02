// Line icons drawn as inline SVG (24x24, stroke = current text colour), so they look
// the same on every device - unlike emoji. No attributes named "style", so the
// page's Content-Security-Policy stays strict.
const PATHS = {
  truck: `<path d="M1 5h13v11H1z"/><path d="M14 9h4.5l3.5 3.5V16h-8"/><circle cx="5.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>`,
  cash: `<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>`,
  store: `<path d="M2.5 9 4.5 4h15l2 5z"/><path d="M4 9v11h16V9"/><path d="M9.5 20v-6h5v6"/>`,
  gift: `<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13"/><path d="M12 8C10.5 4 6.5 4 6.5 6.2S9.5 8 12 8zm0 0c1.5-4 5.5-4 5.5-1.8S14.5 8 12 8z"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  cart: `<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 2-1.5L21.5 8H6"/>`,
  cartPlus: `<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 2-1.5L21.5 8H6"/><path d="M14 9.5v4M12 11.5h4"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>`,
  package: `<path d="m21 8-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>`,
  pin: `<path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7"/>`,
  checkCircle: `<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  minus: `<path d="M5 12h14"/>`,
  trash: `<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>`,
  grid: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  arrow: `<path d="M19 12H5M11 18l-6-6 6-6"/>`,
  chat: `<path d="M3 21l1.8-5.2A8.5 8.5 0 1 1 8.2 19.3z"/>`,
};

export function icon(name, size = 20) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
}
