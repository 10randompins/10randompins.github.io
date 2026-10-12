// Site configuration. Committed to git, so no secrets here.
// The API key lives in config.local.js (git-ignored), which the deploy workflow
// generates from the GOOGLE_MAPS_API_KEY repository secret.
window.TRP_CONFIG = {
  googleMapsApiKey: "",
  // A Map ID from Google Cloud Console (Map Management). "DEMO_MAP_ID" works for testing.
  mapId: "DEMO_MAP_ID",
  // Small Street View thumbnails in the results strip (uses the Street View Static API).
  thumbnails: true,
};
