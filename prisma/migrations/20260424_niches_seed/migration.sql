-- Seed 8 initial niches for trend suggestions feature
INSERT INTO "niches" ("id", "slug", "name", "emoji", "description", "redditSubs", "twitterHashtags", "pinterestQuery", "tiktokHashtags", "enabled", "sortOrder", "createdAt") VALUES
(gen_random_uuid(), 'pet-lovers', 'Pet Lovers', '🐾', 'Designs for cat & dog parents', ARRAY['dogs','cats','aww'], ARRAY['DogLovers','CatMom'], 'pet typography design', ARRAY['doglife','catstagram'], true, 1, now()),
(gen_random_uuid(), 'gaming', 'Gaming', '🎮', 'Gamer culture & references', ARRAY['gaming','pcmasterrace'], ARRAY['Gaming','PCMasterRace'], 'gaming logo design retro', ARRAY['gamertok'], true, 2, now()),
(gen_random_uuid(), 'fitness', 'Fitness', '💪', 'Gym & motivation', ARRAY['fitness','gym'], ARRAY['GymTok','FitFam'], 'fitness motivation typography', ARRAY['gymtok','fitfam'], true, 3, now()),
(gen_random_uuid(), 'nurse-life', 'Nurse Life', '🩺', 'For healthcare workers', ARRAY['nursing'], ARRAY['NurseLife','ScrubLife'], 'nurse quote typography', ARRAY['nurselife'], true, 4, now()),
(gen_random_uuid(), 'mom-life', 'Mom Life', '👩‍👧', 'For moms', ARRAY['mommit'], ARRAY['MomLife','BoyMom'], 'mom life shirt design', ARRAY['momtok'], true, 5, now()),
(gen_random_uuid(), 'fishing-outdoors', 'Fishing & Outdoors', '🎣', 'Anglers & outdoor enthusiasts', ARRAY['fishing','outdoors'], ARRAY['FishingLife','BassFishing'], 'fishing typography retro', ARRAY['fishtok'], true, 6, now()),
(gen_random_uuid(), 'coffee-vibes', 'Coffee Vibes', '☕', 'Coffee lovers & baristas', ARRAY['coffee','espresso'], ARRAY['CoffeeLover','BaristaLife'], 'coffee quote design', ARRAY['coffeetok'], true, 7, now()),
(gen_random_uuid(), 'faith-spiritual', 'Faith & Spiritual', '🙏', 'Faith-based designs', ARRAY['Christianity'], ARRAY['JesusLoves','Faith'], 'christian shirt design', ARRAY['christiantiktok'], true, 8, now())
ON CONFLICT ("slug") DO NOTHING;
