/* Keep Club achievements engine.
 *
 * This file deliberately owns rules and presentation policy, but not storage
 * or UI. The app supplies a snapshot of facts, persists the returned unlock
 * map, and decides when to render the returned records. Keeping that boundary
 * makes the rules deterministic, lets imported and built-in courses use the
 * same engine, and prevents a course from redefining what an achievement
 * means.
 *
 * It is a classic script rather than a module so the offline app can load it
 * before app.js without adding another module graph. The public functions are
 * pure and are also exercised in Node through a VM.
 */
(function installAchievements(global) {
  'use strict';

  const VERSION = 1;
  const SOLID_DAYS = 21;
  const LEECH_AT = 3;
  const SHARE = Object.freeze({
    PRIVATE: 'private',
    AVAILABLE: 'available',
    PROMPT: 'prompt',
  });
  const SURFACES = Object.freeze({
    QUIET: Object.freeze(['toast', 'progress']),
    SHAREABLE: Object.freeze(['toast', 'session', 'progress']),
    RECAP: Object.freeze(['progress', 'recap']),
  });

  const number = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const count = (value) => Math.max(0, Math.round(number(value)));
  const text = (value, fallback = '') => (
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  );
  const plainObject = (value) => (
    !!value && typeof value === 'object' && !Array.isArray(value)
  );
  // New records keep the uncapped, proven interval in `pv`; legacy records
  // predate that meaning, so a missing/zero value falls back to review `ivl`.
  // A valid sr is the canonical-record marker that distinguishes an
  // authoritative zero from those legacy records. Mere property presence is
  // not enough: malformed imported provenance must not erase surviving proof.
  const provenInterval = (rec) => {
    if (!plainObject(rec) || rec.st !== 'r') return 0;
    const persisted = number(rec.pv);
    const rp = count(rec.rp);
    const sr = rec.sr;
    const canonical = Object.prototype.hasOwnProperty.call(rec, 'sr')
      && typeof sr === 'number'
      && Number.isInteger(sr) && sr >= 0 && sr <= rp;
    const legacy = !canonical;
    return Math.max(0, persisted > 0 || !legacy ? persisted : number(rec.ivl));
  };

  const metric = (name, comparison) => Object.freeze(Object.assign(
    { metric: name },
    comparison,
  ));
  const all = (...rules) => Object.freeze({ all: Object.freeze(rules) });

  /** A definition is immutable policy. Course-specific wording is layered on
   * later by catalog(), never written back into these shared objects. */
  function define(spec) {
    if (spec.scope !== 'club' && spec.scope !== 'course') {
      throw new TypeError(`achievement ${spec.id || '(unknown)'} requires an explicit scope`);
    }
    const share = spec.share || SHARE.PRIVATE;
    return Object.freeze(Object.assign({
      family: 'misc',
      art: 'tower',
      share,
      shareable: share !== SHARE.PRIVATE,
      sharePrompt: share === SHARE.PROMPT,
      priority: 0,
      surfaces: share === SHARE.PRIVATE ? SURFACES.QUIET : SURFACES.SHAREABLE,
    }, spec));
  }

  const DEFINITIONS = Object.freeze([
    // Existing ids are permanent: users already have these in state.ach.
    define({
      id: 'cast-off',
      scope: 'club',
      family: 'activity',
      art: 'perch',
      title: 'first card',
      description: 'answered your first card',
      rule: metric('answers', { gte: 1 }),
    }),
    define({
      id: 'underway',
      scope: 'club',
      family: 'activity',
      art: 'flap',
      title: 'fifty',
      description: '50 cards answered',
      rule: metric('answers', { gte: 50 }),
    }),
    define({
      id: 'offshore',
      scope: 'club',
      family: 'activity',
      art: 'carry',
      title: 'two hundred and fifty',
      description: '250 cards answered',
      rule: metric('answers', { gte: 250 }),
      share: SHARE.AVAILABLE,
      priority: 20,
    }),
    define({
      id: 'blue-water',
      scope: 'club',
      family: 'activity',
      art: 'hoard',
      title: 'a thousand',
      description: '1,000 cards answered',
      rule: metric('answers', { gte: 1000 }),
      share: SHARE.AVAILABLE,
      priority: 30,
    }),

    // The three original streak ids retain their semantics. clubStreak falls
    // back to the course streak until the shell has cross-course history.
    define({
      id: 'streak-3',
      scope: 'club',
      family: 'club-streak',
      art: 'peek',
      title: 'three days in the club',
      description: 'studied three days in a row',
      rule: metric('clubStreak', { gte: 3 }),
      priority: 12,
    }),
    define({
      id: 'streak-7',
      scope: 'club',
      family: 'club-streak',
      art: 'roost',
      title: 'a week in the club',
      description: 'studied seven days in a row',
      rule: metric('clubStreak', { gte: 7 }),
      share: SHARE.PROMPT,
      priority: 70,
    }),
    define({
      id: 'streak-14',
      scope: 'club',
      family: 'club-streak',
      art: 'strut',
      title: 'a fortnight in the club',
      description: 'studied fourteen days in a row',
      rule: metric('clubStreak', { gte: 14 }),
      share: SHARE.PROMPT,
      priority: 72,
    }),
    ...[
      [30, 'a month in the club', 78],
      [50, 'fifty days in the club', 80],
      [100, 'a hundred days in the club', 88],
      [365, 'a year in the club', 100],
    ].map(([days, title, priority]) => define({
      id: `streak-${days}`,
      scope: 'club',
      family: 'club-streak',
      title,
      description: `studied ${days} days in a row`,
      rule: metric('clubStreak', { gte: days }),
      share: SHARE.PROMPT,
      priority,
    })),

    // "Solid" is the product promise: the next scheduled review is at least
    // three weeks away. Counts and percentages are separate because a small
    // deck can be mastered without ever reaching a large absolute threshold.
    ...[
      [10, SHARE.PROMPT, 66],
      [25, SHARE.PROMPT, 68],
      [50, SHARE.PROMPT, 70],
      [100, SHARE.PROMPT, 76],
      [250, SHARE.PROMPT, 80],
      [500, SHARE.PROMPT, 84],
    ].map(([cards, share, priority]) => define({
      id: `solid-${cards}`,
      scope: 'club',
      family: 'memories-kept',
      title: `${cards} memories kept`,
      description: `${cards} cards are still there after three weeks`,
      rule: metric('solidCards', { gte: cards }),
      share,
      priority,
    })),
    ...[
      [25, SHARE.AVAILABLE, 48],
      [50, SHARE.PROMPT, 64],
      [75, SHARE.PROMPT, 72],
      [100, SHARE.AVAILABLE, 74],
    ].map(([percent, share, priority]) => define({
      id: `solid-pct-${percent}`,
      scope: 'course',
      family: 'memories-kept',
      title: `${percent}% kept`,
      description: `${percent}% of this deck is solid`,
      rule: all(
        metric('totalCards', { gt: 0 }),
        metric('solidPercent', { gte: percent }),
      ),
      share,
      priority,
    })),

    define({
      id: 'clean-run',
      scope: 'club',
      family: 'personal-best',
      art: 'bow',
      title: 'clean run',
      description: '20 in a row without an again',
      rule: metric('personalBest', { gte: 20 }),
      share: SHARE.AVAILABLE,
      priority: 45,
    }),
    ...[
      [50, 65],
      [100, 75],
    ].map(([cards, priority]) => define({
      id: `personal-best-${cards}`,
      scope: 'club',
      family: 'personal-best',
      title: `${cards} remembered cleanly`,
      description: `a personal best of ${cards} without an again`,
      rule: metric('personalBest', { gte: cards }),
      share: SHARE.PROMPT,
      priority,
    })),

    // Time-of-day achievements are intentionally private Easter eggs. They
    // make the club feel alive without turning unhealthy hours into a target.
    define({
      id: 'night-watch',
      scope: 'club',
      family: 'club-life',
      art: 'puff',
      title: 'night watch',
      description: 'answered a card between midnight and four',
      rule: all(
        metric('hour', { gte: 0 }),
        metric('hour', { lt: 4 }),
      ),
    }),
    define({
      id: 'dawn-patrol',
      scope: 'club',
      family: 'club-life',
      art: 'quill',
      title: 'first light',
      description: 'answered a card before six in the morning',
      rule: all(
        metric('hour', { gte: 4 }),
        metric('hour', { lt: 6 }),
      ),
    }),
    define({
      id: 'lunch-break',
      scope: 'club',
      family: 'club-life',
      title: 'lunch break',
      description: 'kept a memory over lunch',
      rule: all(
        metric('hour', { gte: 12 }),
        metric('hour', { lt: 14 }),
      ),
    }),
    define({
      id: 'weekend-club',
      scope: 'club',
      family: 'club-life',
      title: 'weekend club',
      description: 'showed up on a weekend',
      rule: metric('weekday', { in: Object.freeze([0, 6]) }),
      priority: 5,
    }),
    define({
      id: 'club-tour',
      scope: 'club',
      family: 'club-life',
      title: 'club tour',
      description: 'revised cards from three sections in one session',
      rule: metric('sessionSections', { gte: 3 }),
      priority: 8,
    }),
    define({
      id: 'steady-hand',
      scope: 'club',
      family: 'club-life',
      title: 'steady hand',
      description: 'kept 90% recall over at least 100 repeat cards',
      rule: all(
        metric('repeatAnswers', { gte: 100 }),
        metric('repeatAccuracy', { gte: 90 }),
      ),
      share: SHARE.AVAILABLE,
      priority: 35,
    }),

    define({
      id: 'all-sections',
      scope: 'course',
      family: 'exploration',
      art: 'prints',
      title: 'every corner',
      description: 'started every section in the deck',
      rule: all(
        metric('sections', { gt: 0 }),
        metric('touchedSections', { gteMetric: 'sections' }),
      ),
      share: SHARE.AVAILABLE,
      priority: 35,
    }),
    define({
      id: 'section-swept',
      scope: 'course',
      family: 'exploration',
      art: 'nest',
      title: 'a section swept',
      description: 'seen every card in one section',
      rule: metric('sweptSections', { gte: 1 }),
      share: SHARE.AVAILABLE,
      priority: 32,
    }),
    define({
      id: 'section-kept',
      scope: 'course',
      family: 'mastery',
      title: 'section kept',
      description: 'every card in a section is solid',
      rule: metric('keptSections', { gte: 1 }),
      share: SHARE.PROMPT,
      priority: 82,
    }),
    define({
      id: 'knot-untangled',
      scope: 'course',
      family: 'recovery',
      art: 'worm',
      title: 'unstuck',
      description: 'a card that kept slipping is solid again',
      rule: metric('tamed', { eq: true }),
      share: SHARE.AVAILABLE,
      priority: 58,
    }),
    define({
      id: 'deck-met',
      scope: 'course',
      family: 'exploration',
      art: 'shell',
      title: 'every card met',
      description: 'seen every card in the deck at least once',
      rule: metric('deckSeen', { eq: true }),
      share: SHARE.AVAILABLE,
      priority: 50,
    }),
    define({
      id: 'deck-kept',
      scope: 'course',
      family: 'mastery',
      title: 'deck kept',
      description: 'every card in the deck is solid',
      rule: metric('deckKept', { eq: true }),
      share: SHARE.PROMPT,
      priority: 95,
    }),

    ...[
      [100, SHARE.AVAILABLE, 36],
      [500, SHARE.PROMPT, 60],
      [1000, SHARE.PROMPT, 70],
    ].map(([reviews, share, priority]) => define({
      id: `anki-keeper-${reviews}`,
      scope: 'course',
      family: 'anki-keeper',
      title: `${reviews.toLocaleString('en-US')} imported reviews`,
      description: `kept ${reviews.toLocaleString('en-US')} reviews local`,
      rule: all(
        metric('imported', { eq: true }),
        metric('importedReviews', { gte: reviews }),
      ),
      share,
      priority,
    })),
    define({
      id: 'back-in-club',
      scope: 'club',
      family: 'comeback',
      title: 'back in the club',
      description: 'came back after two weeks away',
      rule: all(
        metric('absenceDays', { gte: 14 }),
        metric('sessionAnswers', { gte: 1 }),
      ),
      share: SHARE.AVAILABLE,
      priority: 25,
    }),
  ]);

  const IDS = Object.freeze(DEFINITIONS.map((definition) => definition.id));
  const ID_SET = new Set(IDS);

  function courseItems(course) {
    // Imported titles and section names are private by default. They also do
    // not bring an achievement theme, so never let a restored local metadata
    // blob replace share-card wording with deck content.
    if (/^local-[a-z0-9]+$/.test(text(course?.id))) {
      return { legacy: {}, modern: {} };
    }
    const legacy = plainObject(course?.hoard?.items) ? course.hoard.items : {};
    const modern = plainObject(course?.achievements?.items) ? course.achievements.items : {};
    return { legacy, modern };
  }

  /** Courses can provide theme, never policy. Even if a course includes rule,
   * share, priority or surfaces fields, they are deliberately ignored. */
  function catalog(course) {
    const { legacy, modern } = courseItems(course);
    return Object.freeze(DEFINITIONS.map((definition) => {
      const oldOverride = plainObject(legacy[definition.id]) ? legacy[definition.id] : {};
      const newOverride = plainObject(modern[definition.id]) ? modern[definition.id] : {};
      const title = text(newOverride.title, text(oldOverride.title, definition.title));
      const description = text(
        newOverride.description,
        text(oldOverride.description, definition.description),
      );
      const art = text(newOverride.art, text(oldOverride.art, definition.art));
      return Object.freeze(Object.assign({}, definition, {
        title,
        description,
        art,
      }));
    }));
  }

  function collectionTitle(course) {
    return text(course?.achievements?.title, text(course?.hoard?.title, 'Milestones'));
  }

  function compareRule(rule, context) {
    if (!rule || !plainObject(rule)) return false;
    if (Array.isArray(rule.all)) return rule.all.every((part) => compareRule(part, context));
    if (Array.isArray(rule.any)) return rule.any.some((part) => compareRule(part, context));
    if (typeof rule.metric !== 'string') return false;

    const value = context[rule.metric];
    if (Object.prototype.hasOwnProperty.call(rule, 'eq') && value !== rule.eq) return false;
    if (Object.prototype.hasOwnProperty.call(rule, 'in')
      && (!Array.isArray(rule.in) || !rule.in.includes(value))) return false;

    const n = Number(value);
    if (Object.prototype.hasOwnProperty.call(rule, 'gte') && !(n >= rule.gte)) return false;
    if (Object.prototype.hasOwnProperty.call(rule, 'gt') && !(n > rule.gt)) return false;
    if (Object.prototype.hasOwnProperty.call(rule, 'lte') && !(n <= rule.lte)) return false;
    if (Object.prototype.hasOwnProperty.call(rule, 'lt') && !(n < rule.lt)) return false;
    if (typeof rule.gteMetric === 'string'
      && !(n >= Number(context[rule.gteMetric]))) return false;
    return true;
  }

  /** Fill aliases and safe numeric defaults without changing the caller's
   * snapshot. A shell-wide streak can be introduced independently; old builds
   * and per-course states keep working through the streak fallback. */
  function normaliseContext(source) {
    const input = plainObject(source) ? source : {};
    const streak = count(input.streak);
    const totalCards = count(input.totalCards);
    const rawSolid = count(input.clubSolid ?? input.solidCards ?? input.solid);
    // A club aggregate is intentionally larger than the currently open deck.
    // Only clamp a course-local solid count to its deck size.
    const solidCards = input.clubSolid === undefined
      ? Math.min(totalCards || Infinity, rawSolid)
      : rawSolid;
    const repeatAnswers = count(input.repeatAnswers ?? input.revTotal);
    const repeatGood = Math.min(repeatAnswers, count(input.repeatGood ?? input.revGood));
    const clean = count(input.personalBest ?? input.bestClean ?? input.clean);
    const rawHour = Number(input.hour);
    const rawWeekday = Number(input.weekday);
    return Object.freeze(Object.assign({}, input, {
      answers: count(input.clubAnswers ?? input.answers),
      streak,
      clubStreak: count(input.clubStreak ?? streak),
      // Unknown time must not look like Sunday at midnight and award two fun
      // achievements merely because a partial context was evaluated.
      hour: Number.isFinite(rawHour) ? Math.max(0, Math.min(23, Math.floor(rawHour))) : -1,
      weekday: Number.isFinite(rawWeekday)
        ? Math.max(0, Math.min(6, Math.floor(rawWeekday))) : -1,
      personalBest: clean,
      clean,
      totalCards,
      solidCards,
      solidPercent: totalCards > 0
        ? Math.max(0, Math.min(100, number(
          input.solidPercent ?? input.solidPct,
          solidCards * 100 / totalCards,
        )))
        : 0,
      sections: count(input.sections),
      touchedSections: count(input.touchedSections ?? input.touched),
      sweptSections: count(input.sweptSections ?? input.swept),
      keptSections: count(input.keptSections ?? input.solidSections),
      sessionAnswers: count(input.sessionAnswers),
      sessionSections: count(input.sessionSections),
      repeatAnswers,
      repeatGood,
      repeatAccuracy: repeatAnswers
        ? Math.max(0, Math.min(100, number(input.repeatAccuracy, repeatGood * 100 / repeatAnswers)))
        : 0,
      importedReviews: count(input.importedReviews ?? (input.imported ? input.answers : 0)),
      absenceDays: count(input.absenceDays ?? input.returnGapDays),
      previousPersonalBest: count(input.previousPersonalBest ?? input.previousBestClean),
      imported: input.imported === true,
      tamed: input.tamed === true,
      deckSeen: input.deckSeen === true,
      deckKept: input.deckKept === true,
    }));
  }

  function unlockMap(source) {
    const out = {};
    if (!plainObject(source)) return out;
    for (const [id, raw] of Object.entries(source)) {
      const at = plainObject(raw) ? Number(raw.at) : Number(raw);
      // Unknown ids are retained for forward compatibility with a newer device.
      if (id && Number.isFinite(at) && at > 0) out[id] = Math.round(at);
    }
    return out;
  }

  function primaryMetric(rule) {
    if (!rule) return null;
    if (typeof rule.metric === 'string') return rule.metric;
    if (Array.isArray(rule.all)) {
      return rule.all.map(primaryMetric).find((name) => (
        name && !['totalCards', 'sections', 'imported'].includes(name)
      )) || null;
    }
    return null;
  }

  function threshold(rule, metricName) {
    if (!rule) return null;
    if (rule.metric === metricName && Number.isFinite(Number(rule.gte))) return Number(rule.gte);
    if (Array.isArray(rule.all)) {
      for (const part of rule.all) {
        const found = threshold(part, metricName);
        if (found !== null) return found;
      }
    }
    return null;
  }

  function recordFor(definition, at, context, course) {
    const metricName = primaryMetric(definition.rule);
    const imported = context.imported === true;
    const courseId = !imported ? text(course?.id) : '';
    const courseTitle = !imported ? text(course?.title) : '';
    return Object.freeze({
      id: definition.id,
      at,
      family: definition.family,
      scope: definition.scope,
      title: definition.title,
      description: definition.description,
      art: definition.art,
      share: definition.share,
      sharePrompt: definition.share === SHARE.PROMPT,
      shareable: definition.share !== SHARE.PRIVATE,
      priority: definition.priority,
      surfaces: definition.surfaces,
      payload: Object.freeze({
        metric: metricName,
        value: metricName ? context[metricName] : null,
        target: metricName ? threshold(definition.rule, metricName) : null,
        imported,
        // Imported names and card content never enter a default share payload.
        courseId: courseId || null,
        courseTitle: courseTitle || null,
      }),
    });
  }

  /** Evaluate one immutable facts snapshot.
   *
   * `at` is required rather than calling Date.now() here: identical inputs
   * always produce identical output, undo can restore the exact prior map, and
   * tests do not need a clock shim. */
  function evaluate(options) {
    const input = plainObject(options) ? options : {};
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= 0) {
      throw new TypeError('KeepClubAchievements.evaluate requires a positive finite at timestamp');
    }
    const courseIsImported = /^local-[a-z0-9]+$/.test(text(input.course?.id));
    const context = normaliseContext(Object.assign({}, input.context, {
      imported: input.context?.imported === true || courseIsImported,
    }));
    const definitions = catalog(input.course);
    const unlocked = unlockMap(input.unlocked);
    const newlyUnlocked = [];

    for (const definition of definitions) {
      if (unlocked[definition.id] || !compareRule(definition.rule, context)) continue;
      unlocked[definition.id] = Math.round(at);
      newlyUnlocked.push(recordFor(definition, Math.round(at), context, input.course));
    }

    return Object.freeze({
      catalog: definitions,
      context,
      newlyUnlocked: Object.freeze(newlyUnlocked),
      unlocked: Object.freeze(unlocked),
    });
  }

  /** Rehydrate one stored unlock for Progress without re-running its rule.
   * This keeps share labels and payload policy in the same place as unlocks. */
  function record(options) {
    const input = plainObject(options) ? options : {};
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= 0) return null;
    const definition = catalog(input.course)
      .find((candidate) => candidate.id === input.id);
    if (!definition) return null;
    const courseIsImported = /^local-[a-z0-9]+$/.test(text(input.course?.id));
    const context = normaliseContext(Object.assign({}, input.context, {
      imported: input.context?.imported === true || courseIsImported,
    }));
    return recordFor(definition, Math.round(at), context, input.course);
  }

  function shareable(records) {
    return (Array.isArray(records) ? records : [])
      .filter((record) => record && record.share !== SHARE.PRIVATE);
  }

  /** Pick one session hero when several thresholds cross on one answer. Sort
   * by product significance, then definition order for a stable tie-break. */
  function bestMoment(records) {
    const order = new Map(IDS.map((id, index) => [id, index]));
    return shareable(records).slice().sort((a, b) => (
      number(b.priority) - number(a.priority)
      || number(order.get(a.id), 1e9) - number(order.get(b.id), 1e9)
      || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
    ))[0] || null;
  }

  function localDayNumber(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(key));
    if (!match) return null;
    const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
    const stamp = Date.UTC(y, m - 1, d);
    const check = new Date(stamp);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1
      || check.getUTCDate() !== d) return null;
    return Math.floor(stamp / 86400000);
  }

  function dayKey(at) {
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      + `-${String(date.getDate()).padStart(2, '0')}`;
  }

  function absenceDays(previousDay, currentDay) {
    const before = localDayNumber(previousDay);
    const now = localDayNumber(currentDay);
    return before === null || now === null ? 0 : Math.max(0, now - before - 1);
  }

  /** Derive deck facts in one pass. The app may add shell-level facts (such as
   * clubStreak) over the returned object before evaluation. */
  function contextFromDeck(options) {
    const input = plainObject(options) ? options : {};
    const state = plainObject(input.state) ? input.state : {};
    const deck = plainObject(input.deck) ? input.deck : {};
    const course = plainObject(input.course) ? input.course : {};
    const session = plainObject(input.session) ? input.session : {};
    const cards = Array.isArray(deck.cards) ? deck.cards : [];
    const sections = Array.isArray(deck.sections) ? deck.sections : [];
    const recs = plainObject(state.recs) ? state.recs : {};
    const at = Number.isFinite(Number(input.at)) ? Number(input.at) : 0;
    const now = new Date(at);
    const sectionCounts = new Map();
    const sectionSeen = new Map();
    const sectionSolid = new Map();
    let seenCards = 0;
    let solidCards = 0;
    let tamed = false;

    for (const card of cards) {
      if (!plainObject(card)) continue;
      const section = String(card.sectionId ?? '');
      sectionCounts.set(section, (sectionCounts.get(section) || 0) + 1);
      const rec = recs[card.cardId];
      if (!plainObject(rec)) continue;
      seenCards++;
      sectionSeen.set(section, (sectionSeen.get(section) || 0) + 1);
      if (provenInterval(rec) >= SOLID_DAYS) {
        solidCards++;
        sectionSolid.set(section, (sectionSolid.get(section) || 0) + 1);
      }
      // Preserve the original recovery rule: after three lapses, a card is
      // considered untangled once it has re-graduated to at least a week.
      if (number(rec.lp) >= LEECH_AT && provenInterval(rec) >= 7) {
        tamed = true;
      }
    }

    const sectionKeys = sections.map((section) => String(section?.sectionId ?? ''));
    const meaningfulSections = sectionKeys.filter((key) => (sectionCounts.get(key) || 0) > 0);
    const sweptSections = meaningfulSections.filter((key) => (
      (sectionSeen.get(key) || 0) >= sectionCounts.get(key)
    )).length;
    const keptSectionKeys = meaningfulSections.filter((key) => (
      (sectionSolid.get(key) || 0) >= sectionCounts.get(key)
    ));
    const explicitSessionSections = Array.isArray(input.sessionSections)
      ? input.sessionSections
      : Array.isArray(session.sectionKeys) ? session.sectionKeys : [];
    const sessionAnswers = count(input.sessionAnswers
      ?? session.answers
      ?? (number(session.good) + number(session.again)));
    const imported = input.imported === true || /^local-[a-z0-9]+$/.test(text(course.id));
    const currentDay = at > 0 ? dayKey(at) : text(state.day);
    const gap = input.absenceDays === undefined
      ? absenceDays(input.previousLastDay, currentDay)
      : count(input.absenceDays);

    return normaliseContext({
      answers: state.answers,
      streak: state.streak,
      clubStreak: input.clubStreak,
      hour: at > 0 ? now.getHours() : input.hour,
      weekday: at > 0 ? now.getDay() : input.weekday,
      personalBest: input.personalBest ?? session.maxClean,
      totalCards: cards.length,
      solidCards,
      sections: meaningfulSections.length,
      touchedSections: [...sectionSeen.keys()].filter((key) => (
        sectionCounts.has(key)
      )).length,
      sweptSections,
      keptSections: keptSectionKeys.length,
      // Stable keys let the UI recognize the exact section that crossed the
      // line without pushing course names or card content into this engine.
      keptSectionKeys: Object.freeze(keptSectionKeys.slice()),
      tamed,
      deckSeen: cards.length > 0 && seenCards >= cards.length,
      deckKept: cards.length > 0 && solidCards >= cards.length,
      imported,
      importedReviews: imported ? state.answers : 0,
      sessionAnswers,
      sessionSections: new Set(explicitSessionSections.map(String)).size,
      repeatAnswers: state.revTotal,
      repeatGood: state.revGood,
      absenceDays: gap,
    });
  }

  /** Combine one state per locally available course into club-wide facts.
   *
   * Storage discovery stays in the shell. This pure reducer never reads
   * localStorage and accepts partial older states, so one abandoned course
   * cannot suppress the learner's streak or lifetime totals.
   */
  function aggregateClubStates(states) {
    const input = Array.isArray(states) ? states : [];
    const days = {};
    const unlocked = {};
    let answers = 0;
    let solidCards = 0;
    let repeatAnswers = 0;
    let repeatGood = 0;
    let personalBest = 0;
    let courseCount = 0;
    let lastDay = '';

    for (const raw of input) {
      if (!plainObject(raw)) continue;
      const courseDays = plainObject(raw.days) ? raw.days : {};
      let countedDays = 0;
      for (const [key, value] of Object.entries(courseDays)) {
        if (localDayNumber(key) === null) continue;
        const valueCount = count(value);
        if (!valueCount) continue;
        days[key] = count(days[key]) + valueCount;
        countedDays += valueCount;
        if (key > lastDay) lastDay = key;
      }

      const courseAnswers = Math.max(count(raw.answers), countedDays);
      answers += courseAnswers;
      const recs = plainObject(raw.recs) ? raw.recs : {};
      if (courseAnswers > 0 || Object.keys(recs).length) courseCount++;
      for (const rec of Object.values(recs)) {
        if (provenInterval(rec) >= SOLID_DAYS) {
          solidCards++;
        }
      }
      repeatAnswers += count(raw.revTotal);
      repeatGood += Math.min(count(raw.revTotal), count(raw.revGood));
      const rawUnlocks = plainObject(raw.ach) ? raw.ach : {};
      const unlockTime = (value) => plainObject(value) ? Number(value.at) : Number(value);
      let provenBest = unlockTime(rawUnlocks['clean-run']) > 0 ? 20 : 0;
      for (const [id, value] of Object.entries(rawUnlocks)) {
        const match = /^personal-best-(\d+)$/.exec(id);
        if (match && unlockTime(value) > 0) provenBest = Math.max(provenBest, count(match[1]));
      }
      personalBest = Math.max(personalBest, count(raw.bestClean), provenBest);
      const claimedLastDay = text(raw.lastDay);
      // A stale/corrupt future lastDay must not move the club cursor onto a
      // date with no answers and collapse an otherwise valid streak to zero.
      if (localDayNumber(claimedLastDay) !== null
          && count(courseDays[claimedLastDay]) && claimedLastDay > lastDay) {
        lastDay = claimedLastDay;
      }

      for (const [id, value] of Object.entries(rawUnlocks)) {
        const at = plainObject(value) ? Number(value.at) : Number(value);
        if (!id || !Number.isFinite(at) || at <= 0) continue;
        if (!unlocked[id] || at < unlocked[id]) unlocked[id] = Math.round(at);
      }
    }

    let clubStreak = 0;
    for (let key = lastDay; key && days[key];) {
      clubStreak++;
      const day = localDayNumber(key);
      if (day === null) break;
      const previous = new Date((day - 1) * 86400000);
      key = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`
        + `-${String(previous.getUTCDate()).padStart(2, '0')}`;
    }
    // Older states intentionally retained only 90 day keys while carrying the
    // exact longer per-course streak. Preserve that proven run when its end is
    // the club's latest study day; new builds retain enough dates to reconstruct
    // cross-course year streaks directly.
    for (const raw of input) {
      if (!plainObject(raw) || text(raw.lastDay) !== lastDay) continue;
      clubStreak = Math.max(clubStreak, count(raw.streak));
    }

    return Object.freeze({
      answers,
      solidCards,
      clubStreak,
      repeatAnswers,
      repeatGood: Math.min(repeatAnswers, repeatGood),
      personalBest,
      courseCount,
      lastDay: lastDay || null,
      days: Object.freeze(days),
      unlocked: Object.freeze(unlocked),
    });
  }

  function monthKey(at) {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) throw new TypeError('monthKey requires a finite timestamp');
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function previousMonthKey(at) {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) {
      throw new TypeError('previousMonthKey requires a finite timestamp');
    }
    date.setDate(1);
    date.setMonth(date.getMonth() - 1);
    return monthKey(date.getTime());
  }

  const MONTH_NAMES = Object.freeze([
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]);

  function monthLabel(key) {
    const match = /^(\d{4})-(\d{2})$/.exec(text(key));
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return '';
    return `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
  }

  /** Build the repeatable monthly moment. It is intentionally not stored in
   * state.ach: its stable `monthly-recap-YYYY-MM` id belongs in a separate
   * seen-recaps set, avoiding an ever-growing achievement catalog. */
  function buildMonthlyRecap(options) {
    const input = plainObject(options) ? options : {};
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= 0) {
      throw new TypeError('buildMonthlyRecap requires a positive finite at timestamp');
    }
    const month = text(input.month, previousMonthKey(at));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new TypeError('buildMonthlyRecap month must be YYYY-MM');
    }
    const days = plainObject(input.days) ? input.days : {};
    const entries = Object.entries(days)
      .filter(([key, value]) => key.startsWith(`${month}-`) && count(value) > 0);
    const answers = entries.reduce((sum, [, value]) => sum + count(value), 0);
    const studyDays = entries.length;
    const completed = month < monthKey(at);
    const eligible = completed && studyDays > 0;
    const solidCards = count(input.solidCards);
    const courseCount = count(input.courseCount);
    const clubStreak = count(input.clubStreak);
    const label = monthLabel(month);
    const record = {
      id: `monthly-recap-${month}`,
      at: Math.round(at),
      scope: 'club',
      family: 'monthly-recap',
      month,
      label,
      title: `${label} at the club`,
      description: `${studyDays} study day${studyDays === 1 ? '' : 's'} · `
        + `${answers} answer${answers === 1 ? '' : 's'} · ${solidCards} solid now`,
      art: 'tower',
      eligible,
      completed,
      share: studyDays >= 3 ? SHARE.PROMPT : SHARE.AVAILABLE,
      sharePrompt: eligible && studyDays >= 3,
      shareable: eligible,
      priority: 86,
      surfaces: SURFACES.RECAP,
      payload: Object.freeze({
        month,
        studyDays,
        answers,
        solidCards,
        courseCount,
        clubStreak,
      }),
    };
    return Object.freeze(record);
  }

  function isMonthlyRecapEligible(options) {
    return buildMonthlyRecap(options).eligible;
  }

  /** A live Progress snapshot, not a persisted trophy. Sharing it tomorrow
   * should use tomorrow's totals rather than the numbers from its first view. */
  function buildMembershipMoment(options) {
    const input = plainObject(options) ? options : {};
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= 0) {
      throw new TypeError('buildMembershipMoment requires a positive finite at timestamp');
    }
    const answers = count(input.answers);
    const solidCards = count(input.solidCards);
    const clubStreak = count(input.clubStreak);
    const courseCount = count(input.courseCount);
    return Object.freeze({
      id: 'membership',
      at: Math.round(at),
      scope: 'club',
      family: 'membership',
      kind: 'repeatable',
      title: 'membership pays in memories',
      description: `${solidCards} solid · ${answers} answer${answers === 1 ? '' : 's'}`
        + (clubStreak ? ` · ${clubStreak} day streak` : ''),
      art: 'tower',
      eligible: answers > 0,
      share: SHARE.AVAILABLE,
      sharePrompt: false,
      shareable: answers > 0,
      priority: 40,
      surfaces: SURFACES.RECAP,
      payload: Object.freeze({
        answers,
        solidCards,
        clubStreak,
        courseCount,
      }),
    });
  }

  function repeatableRecord(spec) {
    if (spec.scope !== 'club' && spec.scope !== 'course') {
      throw new TypeError(`moment ${spec.id || '(unknown)'} requires an explicit scope`);
    }
    const share = spec.share || SHARE.AVAILABLE;
    return Object.freeze(Object.assign({
      family: 'misc',
      art: 'tower',
      kind: 'repeatable',
      share,
      sharePrompt: share === SHARE.PROMPT,
      shareable: share !== SHARE.PRIVATE,
      priority: 0,
      surfaces: share === SHARE.PRIVATE ? SURFACES.QUIET : SURFACES.SHAREABLE,
    }, spec, {
      payload: Object.freeze(spec.payload || {}),
    }));
  }

  function buildPersonalBestMoment(options) {
    const input = plainObject(options) ? options : {};
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= 0) {
      throw new TypeError('buildPersonalBestMoment requires a positive finite at timestamp');
    }
    const best = count(input.bestClean ?? input.personalBest);
    if (best < 20) return null;
    const course = plainObject(input.course) ? input.course : {};
    const imported = /^local-[a-z0-9]+$/.test(text(course.id));
    return repeatableRecord({
      id: `personal-best:${best}`,
      dedupeKey: `personal-best:${best}`,
      at: Math.round(at),
      scope: 'club',
      family: 'personal-best',
      title: `${best} remembered cleanly`,
      description: `a personal best of ${best} without an again`,
      share: SHARE.PROMPT,
      priority: 63 + Math.min(20, Math.floor(best / 25)),
      payload: {
        metric: 'personalBest',
        value: best,
        previous: count(input.previousBestClean ?? input.previousPersonalBest),
        imported,
        // Kept for deterministic records; club-scoped presentation never
        // turns these into a course link.
        courseId: imported ? null : text(course.id) || null,
        courseTitle: imported ? null : text(course.title) || null,
      },
    });
  }

  /** Session-scoped moments are not one-time trophies. A new personal best can
   * improve forever, and each course section deserves its own mastery card.
   * Call this once at session finish; `dedupeKey` lets presentation code avoid
   * showing the same finish twice after a render or navigation.
   *
   * Accepted repeatable inputs:
   * - previousBestClean / bestClean (or their personalBest aliases)
   * - newlyKeptSections: [{ key, title, art }]
   * - monthly: the aggregate accepted by buildMonthlyRecap()
   */
  function sessionMoments(options) {
    const input = plainObject(options) ? options : {};
    const at = Number(input.at);
    if (!Number.isFinite(at) || at <= 0) {
      throw new TypeError('sessionMoments requires a positive finite at timestamp');
    }
    const course = plainObject(input.course) ? input.course : {};
    const courseIsImported = /^local-[a-z0-9]+$/.test(text(course.id));
    const context = normaliseContext(Object.assign({}, input.context, {
      imported: input.context?.imported === true || courseIsImported,
    }));
    const moments = [];
    const previousBest = context.previousPersonalBest;
    const best = context.personalBest;

    if (best >= 20 && best > previousBest && context.sessionAnswers >= 20) {
      const moment = buildPersonalBestMoment({
        at,
        bestClean: best,
        previousBestClean: previousBest,
        course,
      });
      moments.push(Object.freeze(Object.assign({}, moment, {
        description: `a new personal best of ${best} without an again`,
      })));
    }

    const kept = Array.isArray(input.context?.newlyKeptSections)
      ? input.context.newlyKeptSections : [];
    const seenSections = new Set();
    for (const raw of kept) {
      const section = plainObject(raw) ? raw : { key: raw };
      const key = text(section.key);
      if (!key || seenSections.has(key)) continue;
      seenSections.add(key);
      const imported = context.imported;
      const title = imported ? '' : text(section.title);
      const courseArt = plainObject(course.sectionArt) ? text(course.sectionArt[key]) : '';
      moments.push(repeatableRecord({
        id: `section-kept:${key}`,
        dedupeKey: `section-kept:${text(course.id, 'course')}:${key}`,
        at: Math.round(at),
        scope: 'course',
        family: 'mastery',
        art: text(section.art, courseArt || 'tower'),
        title: title ? `${title} — kept` : 'section kept',
        description: 'every card in this section is solid',
        share: SHARE.PROMPT,
        priority: 82,
        payload: {
          metric: 'keptSections',
          value: 1,
          imported,
          // A private imported section name never enters the share model.
          sectionKey: imported ? null : key,
          sectionTitle: title || null,
          courseId: imported ? null : text(course.id) || null,
          courseTitle: imported ? null : text(course.title) || null,
        },
      }));
    }

    if (plainObject(input.monthly)) {
      const recap = buildMonthlyRecap(Object.assign({}, input.monthly, { at }));
      if (recap.eligible) moments.push(recap);
    }
    return Object.freeze(moments);
  }

  global.KeepClubAchievements = Object.freeze({
    VERSION,
    SOLID_DAYS,
    LEECH_AT,
    SHARE,
    IDS,
    DEFINITIONS,
    catalog,
    collectionTitle,
    normaliseContext,
    contextFromDeck,
    aggregateClubStates,
    evaluate,
    record,
    shareable,
    bestMoment,
    monthKey,
    previousMonthKey,
    buildMonthlyRecap,
    isMonthlyRecapEligible,
    buildMembershipMoment,
    buildPersonalBestMoment,
    sessionMoments,
    // Exposed for contract tests and future rule tooling, not for courses.
    matches: compareRule,
    isKnownId: (id) => ID_SET.has(id),
  });
}(typeof globalThis !== 'undefined' ? globalThis : window));
