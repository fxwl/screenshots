export { buildCookieLogicalId, buildLocalStorageLogicalId, normalizeCookieStoreScope } from './ids';
export {
  HlcClock,
  incrementVectorClock,
  mergeVectorClocks,
  compareVectorClocks,
  compareHlcDeterministic,
  createNextCausalVersion,
} from './clock';
export {
  resolveItemMerge,
  updateTombstoneReclaimability,
  type MergeOutcome,
} from './merge';
export {
  evaluateSiteDiscovery,
  applyUserSiteDecision,
  resolveAutomaticSiteDecisionAction,
  type SiteDiscoveryInput,
  type SiteDiscoveryDecision,
} from './discovery';
