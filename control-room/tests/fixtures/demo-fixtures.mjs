// Demo fixtures (stage 4, docs/rebuild/05-demo.md Task 4): 10 made-up leads and 12 hostile strings, shared by the demo
// tests (demo-data, demo-render, demo-api). Not a test file itself (tests/fixtures/ isn't matched by *.test.mjs).
//
// LEADS.<key> is a raw `leads` row (every column of lead-manager/schema.sql's leads table) plus `.research`, its raw
// `research` row (every column of the research table). They come the way D1 gives them, mostly JSON text, with a few
// objects on purpose so both paths are covered: LEADS.full.research.copy is an object (the spec's test reads
// `.copy.services`), and some `audit` columns are objects, others JSON text. To seed a database:
//   const { research, ...lead } = LEADS.full; seedLead(DB, lead); seedResearch(DB, research);   // helpers/shortlistSeed.mjs
//
// The cases Part A lists: 5 landscapers (full data, no photos, http-only photos, a pale colour #a0ffff, bare: no
// copy/reviews/phone/town/rating/logo/photos) and 5 others (kickboxing gym in ALL CAPS with "LTD", a roofer with "&"
// whose colour gets darkened, a plumber with a keyword-stuffed name, no headline, a non-dialable phone and only the
// searched town, a locksmith with an 80-character name, an electrician with reviews longer than 320 characters).
// Every one is graded A+, A or B with an email, so every one is demo-eligible.
//
// Every business, person, address and URL is invented (.example domains). Phone numbers are in Ofcom's ranges for
// drama, except LEADS.full's 07969 770905, which the render tests expect as tel:07969770905.
//
// Everything here is deep-frozen: build changed copies with spread ({ ...LEADS.full, rating: 0 }), never by writing
// into a fixture, so no test can change another test's data.

const AT = "2026-10-20T09:00:00Z";

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

// A `leads` row with every column, defaults first.
function leadRow(o) {
  return {
    place_id: o.place_id, name: o.name, trade: o.trade, search_town: o.search_town ?? o.town ?? "", rank: 3,
    address: null, town: null, postcode: null, phone: null, website: null, maps_url: null, rating: null,
    review_count: null, email: null, emails: "[]", socials: "{}", issues: "[]", audit: null,
    director_first_name: null, director_name: null, company_number: null, excluded: 0, exclude_reason: null,
    quality_score: 55, warmth_score: 0, status: "new", notes: "", last_job_id: null, first_seen_at: AT, updated_at: AT,
    ...o,
  };
}

// A `research` row with every column: done, graded, an email found, not too big.
function researchRow(o) {
  return {
    place_id: o.place_id, status: "done", grade: "A",
    points: JSON.stringify({ need: 4, means: 4, reach: 4, fit: 4 }),
    grade_reason: "Busy local business whose website doesn't show what they do; a site that does would win calls.",
    angle: JSON.stringify([{ fact: "Their Google profile has more reviews than their website shows.", source_url: "https://maps.example/p" }]),
    opener: "Saw your Google reviews and made you something.",
    owner: JSON.stringify({ first: "", full: "", source_url: "", confident: false }),
    best_email: null, best_email_why: "The address on their contact page.",
    emails: "[]", copy: null,
    site_review: JSON.stringify({ verdict: "weak", summary: "Hard to use on a phone.", problems: ["No services listed"], good: [] }),
    too_big: 0, notes: "", searched: "[]", queued_at: AT, researched_at: AT,
    ...o,
  };
}

const GL = "https://greenleaf-landscapes.example/img";

export const LEADS = deepFreeze({
  // Landscaper with everything: logo (also in the photo list), their colour, 6 https photos and one http one, 8
  // services, 7 areas, 8 reviews of which only 4 are real, rated 4-5 and 8+ words long (Sarah's is the longest).
  full: {
    ...leadRow({
      place_id: "fx-full", name: "Green Leaf Landscapes Ltd", trade: "landscaper", search_town: "Warrington",
      address: "12 Example Road, Warrington WA1 1AA", town: "Warrington", postcode: "WA1 1AA", phone: "07969 770905",
      website: "https://greenleaf-landscapes.example", maps_url: "https://maps.example/?cid=101", rating: 4.8,
      review_count: 37, email: "hello@greenleaf-landscapes.example",
      emails: JSON.stringify(["hello@greenleaf-landscapes.example", "dave@greenleaf-landscapes.example"]),
      director_first_name: "Dave", director_name: "David Green", quality_score: 62,
      audit: {
        final_url: "https://greenleaf-landscapes.example/",
        brand: {
          logo: `${GL}/logo.png`,
          colour: "#2e7d32",
          photos: [`${GL}/logo.png`, `${GL}/patio.jpg`, `${GL}/lawn.jpg`, `${GL}/fence.jpg`, `${GL}/deck.jpg`,
            `${GL}/border.jpg`, `${GL}/path.jpg`, "http://greenleaf-landscapes.example/img/old.jpg"],
        },
        reviews: [
          { author: "Mark Unrated", rating: null, text: "No star rating came with this one, so it must never be shown, however long and glowing it is: they laid our patio, rebuilt the wall, turfed the back lawn and cleared the side passage." },
          { author: "Jo Lowe", rating: 3, text: "Three stars only: the work was fine in the end but it took longer than they said and we had to chase them twice before the last panels went in." },
          { author: "Ben String", rating: "5", text: "This rating arrived as text instead of a number, so it isn't a real Google rating and the review must be left out even though it is long." },
          { author: "Ann Short", rating: 5, text: "Great job, thanks!" },
          { author: "Tom Hill", rating: 5, text: "Turned up when they said they would and did a lovely job on our new fence panels." },
          { author: "Sarah Jane Kent", rating: 5, text: "Dave and the team rebuilt our patio and laid a new lawn in under a week. Tidy, polite and the finish is lovely. We'd happily have them back for the front garden." },
          { author: "", rating: 4, text: "Good value and the new paving has made the garden feel twice the size." },
          { author: "Priya", rating: 5, text: "Friendly, quick and left everything spotless at the end." },
        ],
      },
    }),
    research: researchRow({
      place_id: "fx-full", grade: "A",
      owner: JSON.stringify({ first: "Dave", full: "David Green", source_url: "https://greenleaf-landscapes.example/about", confident: true }),
      best_email: "dave@greenleaf-landscapes.example",
      emails: JSON.stringify([{ email: "dave@greenleaf-landscapes.example", source_url: "https://greenleaf-landscapes.example/contact", where: "contact page" }]),
      copy: {
        headline: "Patios, lawns and garden makeovers in Warrington",
        intro: "Dave Green and his small team design and build gardens for homes across Warrington, from new patios and lawns to complete makeovers.",
        services: ["Garden design", "Patios and paving", "Turfing and new lawns", "Fencing and gates", "Decking",
          "Artificial grass", "Garden clearance", "Planting and borders"],
        areas: ["Warrington", "Lymm", "Culcheth", "Great Sankey", "Stockton Heath", "Penketh", "Birchwood"],
        about: "Green Leaf Landscapes is Dave Green's business. He started it in 2012 and still prices every job himself on site. The same small team that starts your garden finishes it.",
      },
    }),
  },

  // Landscape trade by another name, audit and copy as JSON text, no photos (photo-free hero), logo and colour kept.
  noPhotos: {
    ...leadRow({
      place_id: "fx-no-photos", name: "Hedge & Edge Garden Services", trade: "garden maintenance", search_town: "Widnes",
      town: "Widnes", phone: "0151 496 0123", website: "https://hedge-and-edge.example", rating: 4.6, review_count: 12,
      audit: JSON.stringify({
        brand: { logo: "https://hedge-and-edge.example/logo.png", colour: "#1e5631", photos: [] },
        reviews: [
          { author: "Kate M.", rating: 5, text: "Our hedges have never looked this neat, and they always tidy up afterwards." },
          { author: "Gary Holt", rating: 4, text: "Reliable every fortnight through the summer and fair on price too." },
        ],
      }),
    }),
    research: researchRow({
      place_id: "fx-no-photos", grade: "A", best_email: "info@hedge-and-edge.example",
      copy: JSON.stringify({
        headline: "Gardens kept neat across Widnes",
        intro: "Regular garden maintenance, hedge cutting and lawn care for homes in Widnes and nearby.",
        services: ["Hedge cutting", "Lawn mowing", "Garden tidy-ups", "Pruning"],
        areas: ["Widnes", "Hough Green", "Ditton"],
        about: "Hedge & Edge looks after gardens across Widnes every week of the growing season.",
      }),
    }),
  },

  // Their only photos and logo are http:// (blocked on our https page): all dropped, photo-free, name wordmark; no
  // colour found, so the landscaper default.
  httpPhotos: {
    ...leadRow({
      place_id: "fx-http-photos", name: "Oakfield Turf and Paving", trade: "landscaper", search_town: "Runcorn",
      town: "Runcorn", phone: "07700 900123", website: "http://oakfield-turf.example", rating: 5, review_count: 3,
      audit: {
        brand: {
          logo: "http://oakfield-turf.example/logo.png", colour: "",
          photos: ["http://oakfield-turf.example/a.jpg", "http://oakfield-turf.example/b.jpg", "http://oakfield-turf.example/c.jpg"],
        },
        reviews: [
          { author: "Lee Ward", rating: 5, text: "New driveway and turf done in two days, and it looks brilliant." },
          { author: "Sam", rating: 5, text: "Very happy." },
        ],
      },
    }),
    research: researchRow({
      place_id: "fx-http-photos", grade: "B", best_email: "oakfieldturf@example.com",
      copy: JSON.stringify({
        headline: "Turf, driveways and paving in Runcorn",
        intro: "New lawns, block paving and driveways laid for homes around Runcorn.",
        services: ["Turfing", "Block paving", "Driveways"],
        areas: ["Runcorn"],
        about: "",
      }),
    }),
  },

  // Their colour is too pale for white text even 50% darker: Charcoal. Two photos (hero + one recent work photo).
  // "landscapers" (plural) reads "Landscaping" in a headline.
  paleColour: {
    ...leadRow({
      place_id: "fx-pale-colour", name: "Sunny Patios", trade: "landscapers", search_town: "St Helens",
      town: "St Helens", phone: "07700 900456", website: "https://sunny-patios.example", rating: 4.4, review_count: 8,
      audit: {
        brand: {
          logo: "https://sunny-patios.example/logo.png", colour: "#a0ffff",
          photos: ["https://sunny-patios.example/patio-one.jpg", "https://sunny-patios.example/patio-two.jpg"],
        },
        reviews: [{ author: "Helen Price", rating: 4, text: "Lovely sandstone patio, laid level and finished with neat pointing." }],
      },
    }),
    research: researchRow({
      place_id: "fx-pale-colour", grade: "A", best_email: "sunnypatios@example.com",
      copy: JSON.stringify({
        headline: "Patios laid properly in St Helens",
        intro: "Sandstone, porcelain and block patios for gardens in St Helens.",
        services: ["Sandstone patios", "Porcelain patios", "Steps and edging"],
        areas: ["St Helens", "Rainford", "Haydock"],
        about: "Sunny Patios lays patios and nothing else.",
      }),
    }),
  },

  // The least data a graded lead can have: no copy, reviews, rating, phone, town, website, logo, colour or photos.
  bare: {
    ...leadRow({ place_id: "fx-bare", name: "Tidy Gardens", trade: "landscaper", search_town: "", town: null }),
    research: researchRow({ place_id: "fx-bare", grade: "B", owner: null, best_email: "tidygardens@example.com", copy: null }),
  },

  // ALL CAPS name with "LTD"; generic look; an apostrophe in a service.
  kickboxing: {
    ...leadRow({
      place_id: "fx-kickboxing", name: "DIAMOND KICKBOXING ACADEMY LTD", trade: "kickboxing gym", search_town: "Leeds",
      town: "Leeds", phone: "0113 496 0456", website: "https://diamond-kickboxing.example", rating: 4.9, review_count: 58,
      audit: {
        brand: {
          logo: "https://diamond-kickboxing.example/logo.png", colour: "#b71c1c",
          photos: ["https://diamond-kickboxing.example/class.jpg", "https://diamond-kickboxing.example/kids.jpg",
            "https://diamond-kickboxing.example/pads.jpg"],
        },
        reviews: [
          { author: "Ryan Oakes", rating: 5, text: "Brilliant coaches who make complete beginners feel welcome from the very first class." },
          { author: "Mel Grant", rating: 5, text: "My two kids have come on so much in confidence since starting here." },
          { author: "Chris D.", rating: 5, text: "Tough sessions, great atmosphere and nobody makes you feel out of place." },
        ],
      },
    }),
    research: researchRow({
      place_id: "fx-kickboxing", grade: "A+", best_email: "coach@diamond-kickboxing.example",
      owner: JSON.stringify({ first: "Lisa", full: "Lisa Ward", source_url: "https://diamond-kickboxing.example/coaches", confident: true }),
      copy: JSON.stringify({
        headline: "Kickboxing classes in Leeds for adults and kids",
        intro: "Kickboxing for adults and kids in Leeds, from complete beginners to fighters.",
        services: ["Adult kickboxing", "Kids classes", "Beginners' classes", "Personal training", "Fitness classes"],
        areas: ["Leeds", "Headingley", "Kirkstall"],
        about: "Diamond Kickboxing Academy is coached by Lisa Ward. Kids classes start from age 5.",
      }),
    }),
  },

  // "&" and "Ltd" in the name, +44 phone, a colour that needs darkening, six photos.
  roofer: {
    ...leadRow({
      place_id: "fx-roofer", name: "Smith & Sons Roofing Ltd", trade: "roofer", search_town: "Bolton", town: "Bolton",
      phone: "+44 1632 960077", website: "https://smithandsons-roofing.example", rating: 4.7, review_count: 23,
      audit: {
        brand: {
          logo: "https://smithandsons-roofing.example/logo.png", colour: "#2196f3",
          photos: ["roof-1", "roof-2", "roof-3", "roof-4", "roof-5", "roof-6"].map((p) => `https://smithandsons-roofing.example/${p}.jpg`),
        },
        reviews: [
          { author: "Paul Fenton", rating: 5, text: "Smith & Sons replaced our flat roof & guttering in a day. Spotless afterwards." },
          { author: "Diane Kerr", rating: 4, text: "Found the leak the last roofer missed and fixed it the same week." },
        ],
      },
    }),
    research: researchRow({
      place_id: "fx-roofer", grade: "A", best_email: "office@smithandsons-roofing.example",
      copy: JSON.stringify({
        headline: "Roof repairs and new roofs in Bolton",
        intro: "Smith & Sons repair and replace pitched and flat roofs for homes across Bolton.",
        services: ["Roof repairs", "New roofs", "Flat roofs", "Guttering and fascias", "Chimney repairs"],
        areas: ["Bolton", "Horwich", "Farnworth", "Westhoughton"],
        about: "A father-and-sons roofing business working across Bolton.",
      }),
    }),
  },

  // Keyword-stuffed Google name (cut at " | "), no town but the searched one, no headline (falls back to "Plumber in
  // Manchester"), a phone with too few digits to dial, no logo, one photo. Reviews: one of exactly 8 words (kept), one
  // of 7 (dropped), one rated 2 (dropped).
  plumber: {
    ...leadRow({
      place_id: "fx-plumber", name: "Flowright Plumbing & Heating | Emergency Plumber Manchester", trade: "plumber",
      search_town: "Manchester", town: null, phone: "0161 496 07", rating: 4.3, review_count: 9,
      audit: JSON.stringify({
        brand: { logo: "", colour: "#0d47a1", photos: ["https://flowright.example/bathroom.jpg"] },
        reviews: [
          { author: "Asha Patel", rating: 4, text: "Fixed our leaking pipe quickly and explained everything." },
          { author: "Ian Moss", rating: 5, text: "Quick, clean and fair. Would recommend them." },
          { author: "Rob Dunn", rating: 2, text: "Did the job in the end but turned up three hours late without calling." },
        ],
      }),
    }),
    research: researchRow({
      place_id: "fx-plumber", grade: "B", best_email: "flowright@example.com",
      copy: JSON.stringify({
        headline: "",
        intro: "Plumbing and heating repairs for homes in Manchester.",
        services: ["Leak repairs", "Boiler repairs", "Bathroom fitting"],
        areas: ["Manchester", "Didsbury", "Chorlton"],
        about: "",
      }),
    }),
  },

  // An 80-character business name (no " - ", " | " or "Ltd" to cut), no photos, a near-black colour.
  locksmith: {
    ...leadRow({
      place_id: "fx-locksmith", name: "Northern Quarter Emergency Locksmiths and Home Security Specialists of Stockport",
      trade: "locksmith", search_town: "Stockport", town: "Stockport", phone: "+44 161 496 0789",
      website: "https://nq-locksmiths.example", rating: 4.8, review_count: 41,
      audit: {
        brand: { logo: "https://nq-locksmiths.example/logo.png", colour: "#212121", photos: [] },
        reviews: [
          { author: "Gemma Shaw", rating: 5, text: "Locked out late at night and they had us back inside within half an hour." },
          { author: "Omar Farouk", rating: 5, text: "Changed every lock after our break-in and talked us through better security." },
        ],
      },
    }),
    research: researchRow({
      place_id: "fx-locksmith", grade: "A", best_email: "help@nq-locksmiths.example",
      copy: JSON.stringify({
        headline: "Locksmiths in Stockport, day and night",
        intro: "Lockouts, lock changes and home security for Stockport and south Manchester.",
        services: ["Lockouts", "Lock changes", "uPVC door repairs", "Home security checks"],
        areas: ["Stockport", "Cheadle", "Bramhall", "Marple"],
        about: "A small team of locksmiths based in Stockport.",
      }),
    }),
  },

  // Reviews far longer than 320 characters (clipped at a word with "…"), one with line breaks; a yellow that needs
  // darkening.
  electrician: {
    ...leadRow({
      place_id: "fx-electrician", name: "Bright Spark Electrical", trade: "electrician", search_town: "Wigan",
      town: "Wigan", phone: "01632 960123", website: "https://brightspark.example", rating: 4.9, review_count: 112,
      audit: {
        brand: {
          logo: "https://brightspark.example/logo.png", colour: "#f9a825",
          photos: ["https://brightspark.example/board.jpg", "https://brightspark.example/kitchen.jpg",
            "https://brightspark.example/garden-lights.jpg", "https://brightspark.example/charger.jpg"],
        },
        reviews: [
          { author: "Natalie Brooks", rating: 5, text: "We had Bright Spark rewire our whole house after we bought it, and from the first visit to the final certificate they were excellent. They explained what needed doing and why, gave us a clear price before starting, kept the mess to a minimum, protected the floors, and finished a day earlier than planned. The new consumer unit is neat and labelled, and they even moved two sockets we asked about halfway through without any fuss at all." },
          { author: "Dev Mistry", rating: 5, text: "Called them when half the house tripped and nobody else could come out.\n\nThey found a failed outdoor light fitting that had been letting water in, replaced it, tested every circuit and showed me the readings. Honest, tidy and quick, and they didn't try to sell me anything I didn't need. I've since had them back to fit an electric car charger on the drive and the job was just as good as the first time round." },
          { author: "Claire Hughes", rating: 4, text: "Good, careful work fitting new kitchen lighting and extra sockets. The only reason it's four stars and not five is that the first date had to move, but they rang well ahead to tell us, and the job itself was spotless. They patched the plaster where the cables went in so neatly you can't see it, and left us with all the paperwork for building control." },
          { author: "Steve Lomax", rating: 5, text: "The best electrician we have used in Wigan by a distance. Turned up on time, every time, over a three day job adding garden lighting and an outside socket. Every cable is buried properly, every fitting is straight, and they cleared up so well you'd never know they had been. Already booked them again for the loft conversion next spring." },
        ],
      },
    }),
    research: researchRow({
      place_id: "fx-electrician", grade: "A+", best_email: "jobs@brightspark.example",
      copy: JSON.stringify({
        headline: "Rewires, lighting and EV chargers in Wigan",
        intro: "Electrical work for homes across Wigan: rewires, consumer units, lighting and car chargers.",
        services: ["Rewires", "Consumer unit upgrades", "Lighting", "EV chargers", "Electrical safety checks"],
        areas: ["Wigan", "Orrell", "Standish", "Ince"],
        about: "Bright Spark Electrical is a two-person team working across Wigan.",
      }),
    }),
  },
});

// The 12 hostile strings (Part A edge cases): HTML, attribute breaks, CSS, URLs, templates and a bidi override.
// NASTY[6] starts with a real U+202E (right-to-left override) character: written as \u202E so the source shows it.
export const NASTY = deepFreeze([
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "</style><script>x()</script>",
  "javascript:alert(1)",
  "' onmouseover='x",
  "{{7*7}}",
  "\u202Eevil",
  "red;}body{display:none",
  'https://x.co/a.jpg" onerror="x',
  "<!--",
  "]]>",
  "&amp;lt;",
]);

/**
 * LEADS.full with `n` in every field a demo prints or links: name, trade, town, phone, logo, colour, photos, one
 * rated review (author, and text of 8+ words so it is kept), and every copy field, service and area. Fixture-shaped
 * (a leads row plus `.research`), not frozen.
 */
export function nastyLead(n) {
  const { research, ...lead } = LEADS.full;
  return {
    ...lead, place_id: "fx-nasty", name: n, trade: n, town: n, search_town: n, phone: n,
    audit: { brand: { logo: n, colour: n, photos: [n, `${n} ${n}`] }, reviews: [{ author: n, rating: 5, text: Array(8).fill(n).join(" ") }] },
    research: {
      ...research, place_id: "fx-nasty",
      copy: { headline: n, intro: n, services: [n, `${n} two`], areas: [n, `${n} two`], about: n },
    },
  };
}
