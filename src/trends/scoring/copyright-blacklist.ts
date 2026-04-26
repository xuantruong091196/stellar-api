export const COPYRIGHT_BLACKLIST: string[] = [
  'disney', 'marvel', 'star wars', 'pokemon', 'nintendo', 'harry potter',
  'lord of the rings', 'game of thrones', 'breaking bad', 'stranger things',
  'nike', 'adidas', 'puma', 'under armour', 'lululemon', 'supreme',
  'coca-cola', 'pepsi', 'mcdonalds', 'starbucks',
  'nfl', 'nba', 'mlb', 'nhl', 'fifa',
  'apple', 'google', 'microsoft', 'amazon', 'tesla',
  'spotify', 'taylor swift', 'beyonce', 'drake', 'kanye',
];

export function blacklistMatch(text: string): string[] {
  const lower = text.toLowerCase();
  return COPYRIGHT_BLACKLIST.filter((brand) => {
    const escaped = brand.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
  });
}
