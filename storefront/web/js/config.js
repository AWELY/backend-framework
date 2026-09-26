// Where the store's API lives. By default: same host as the website, port 3000.
// Change API_PORT (or set window.AMA_API_BASE before the scripts load) for another setup.
const API_PORT = 3000;

export const API_BASE = window.AMA_API_BASE ?? `${location.protocol}//${location.hostname}:${API_PORT}`;

export const STORE = {
  name: "AMA",
  tagline: "إلكترونيات وإكسسوارات الهواتف",
  address: "طرابلس - تاجوراء",
  // WhatsApp number in international format without "+", e.g. "2189XXXXXXXX".
  // Empty = the WhatsApp button is hidden.
  whatsapp: "",
};
