/**
 * FruitNinja static dataset — optimal cutting techniques for common fruits
 */

export interface CuttingStep {
  step: number;
  instruction: string;
}

export interface FruitEntry {
  name: string;
  aliases: string[];
  emoji: string;
  difficulty: "easy" | "medium" | "hard";
  tools: string[];
  preparation: string;
  technique: string;
  steps: CuttingStep[];
  tips: string[];
  safetyNotes: string[];
  servingIdeas: string[];
}

export const FRUIT_DATABASE: FruitEntry[] = [
  {
    name: "apple",
    aliases: ["granny smith", "fuji", "gala", "honeycrisp", "red apple", "green apple"],
    emoji: "🍎",
    difficulty: "easy",
    tools: ["chef's knife", "cutting board"],
    preparation: "Wash the apple thoroughly under cold running water.",
    technique: "Pole-to-pole quartering",
    steps: [
      { step: 1, instruction: "Place the apple upright on the cutting board with the stem facing up." },
      { step: 2, instruction: "Cut straight down through the centre, slicing the apple in half." },
      { step: 3, instruction: "Lay each half cut-side down and cut again to make quarters." },
      { step: 4, instruction: "Hold each quarter at a 45° angle and slice out the core and seeds with a single angled cut." },
      { step: 5, instruction: "Slice each quarter into thin wedges or chunks as desired." }
    ],
    tips: [
      "Toss cut apple in a little lemon juice to prevent browning.",
      "For a fan presentation, keep slices attached at the base.",
      "An apple corer can speed up step 3–4 if you have one."
    ],
    safetyNotes: [
      "Keep fingers curled inward (the 'bear claw' grip) when slicing.",
      "Stabilise the apple before cutting — it can roll."
    ],
    servingIdeas: ["fruit salad", "apple pie", "caramel dip", "cheese board"]
  },
  {
    name: "avocado",
    aliases: ["avo", "alligator pear"],
    emoji: "🥑",
    difficulty: "medium",
    tools: ["chef's knife", "spoon", "cutting board"],
    preparation: "Rinse the avocado under water. Check ripeness by gently pressing — it should yield slightly.",
    technique: "Halve, pit, and scoop",
    steps: [
      { step: 1, instruction: "Hold the avocado lengthways and cut around the pit with a chef's knife, rotating the fruit rather than the knife." },
      { step: 2, instruction: "Twist the two halves apart." },
      { step: 3, instruction: "To remove the pit: cup the half in a folded towel, then carefully strike the pit with the heel of the knife and twist out. Alternatively, use a spoon to lever it out — safer." },
      { step: 4, instruction: "Score a grid pattern into the flesh (without piercing the skin) for cubes, or make lengthways slices for slices." },
      { step: 5, instruction: "Scoop out the flesh with a large spoon, keeping it intact." }
    ],
    tips: [
      "The pit-strike technique looks impressive but a spoon is safer for home cooks.",
      "Leave the stone in unused halves to slow browning; wrap tightly in cling film.",
      "A ripe avocado peels away from the skin cleanly — if it doesn't, it needs more time."
    ],
    safetyNotes: [
      "'Avocado hand' is a real A&E injury — never strike the pit while holding the fruit in your palm without a towel.",
      "Keep the knife away from your off-hand when halving."
    ],
    servingIdeas: ["guacamole", "toast", "salad", "sushi rolls"]
  },
  {
    name: "mango",
    aliases: ["alphonso", "kent", "tommy atkins", "ataulfo"],
    emoji: "🥭",
    difficulty: "medium",
    tools: ["chef's knife", "cutting board", "spoon or peeler (optional)"],
    preparation: "Wash the mango. Stand it upright to identify where the flat pit runs — it runs lengthways through the centre.",
    technique: "Hedgehog / cheek method",
    steps: [
      { step: 1, instruction: "Stand the mango on one end. Slice down either side of the flat pit, cutting as close to it as possible to get two large 'cheeks'." },
      { step: 2, instruction: "Score a grid into each cheek's flesh — rows and columns about 1 cm apart — without cutting through the skin." },
      { step: 3, instruction: "Push the cheek inside-out by pressing the skin side upward with both thumbs. The cubes will fan out ('hedgehog' style)." },
      { step: 4, instruction: "Slice the cubes off the skin with a knife, or serve directly in the hedgehog presentation." },
      { step: 5, instruction: "Trim the remaining flesh around the pit and dice or nibble off the skin." }
    ],
    tips: [
      "A ripe mango will smell fragrant at the stem end.",
      "The cheeks are easiest to peel when the mango is ripe but still slightly firm.",
      "Use a vegetable peeler on the pit portion for extra flesh."
    ],
    safetyNotes: [
      "Mango skin contains urushiol (same as poison ivy) — wear gloves if you have a latex allergy.",
      "The pit is fibrous and hard; keep fingers clear when slicing close to it."
    ],
    servingIdeas: ["mango salsa", "smoothies", "fruit salad", "sticky rice", "chutney"]
  },
  {
    name: "pineapple",
    aliases: ["ananas"],
    emoji: "🍍",
    difficulty: "hard",
    tools: ["large chef's knife", "cutting board", "pineapple corer (optional)"],
    preparation: "Lay the pineapple on its side on a stable cutting board. A ripe pineapple will smell sweet at the base and a leaf pulls out easily.",
    technique: "Crown-off, skin-down cylindrical slicing",
    steps: [
      { step: 1, instruction: "Slice off the crown (leafy top) and the base — remove about 1 cm on each side to expose the flesh." },
      { step: 2, instruction: "Stand the pineapple upright. Cut downward slices following the curve of the fruit to remove the skin, working around the outside." },
      { step: 3, instruction: "Use the tip of the knife to cut out any remaining 'eyes' (brown spots) in a shallow V-cut along the diagonal lines they form." },
      { step: 4, instruction: "Stand the peeled pineapple upright and slice into rounds, or quarter it vertically first." },
      { step: 5, instruction: "For spears: quarter lengthways, then cut out the tough core triangle from each quarter. Slice the quarters into spears or chunks." }
    ],
    tips: [
      "The diagonal eye-removal cut follows the natural spiral of the fruit and wastes the least flesh.",
      "A pineapple corer handles steps 2–5 in one motion if you have one.",
      "Canned pineapple is a perfectly respectable shortcut for cooked dishes."
    ],
    safetyNotes: [
      "A pineapple is dense and can roll — stabilise it firmly before each cut.",
      "The crown leaves are sharp; grip below the base of the leaves when handling.",
      "Use a large, sharp knife — a blunt knife requires more force and increases slip risk."
    ],
    servingIdeas: ["grilling", "piña colada", "tropical salsa", "pizza (controversial)", "fruit skewers"]
  },
  {
    name: "watermelon",
    aliases: ["water melon"],
    emoji: "🍉",
    difficulty: "medium",
    tools: ["large chef's knife", "cutting board", "melon baller (optional)"],
    preparation: "Wash the outside rind thoroughly. Place on a large stable cutting board.",
    technique: "Halve, then slice or cube",
    steps: [
      { step: 1, instruction: "Slice a thin piece off one side to create a flat base, so the melon doesn't roll." },
      { step: 2, instruction: "Stand the melon on its flat base and slice straight down through the centre." },
      { step: 3, instruction: "For triangles: lay each half cut-side down and slice into half-moon rounds, then cut each round into triangles." },
      { step: 4, instruction: "For cubes: cut the half into long slices, then cut the rind off each slice by running the knife between flesh and rind. Stack and dice into cubes." },
      { step: 5, instruction: "For sticks: cut the halves into long wedges from the centre, leave the rind as a handle." }
    ],
    tips: [
      "Chilling the melon before cutting makes it firmer and easier to slice.",
      "A melon baller creates elegant spheres for fruit salads.",
      "Salt brings out watermelon's sweetness — a tiny pinch on each slice is a game-changer."
    ],
    safetyNotes: [
      "Watermelons are heavy and round — the flat base cut (step 1) is essential to prevent rolling.",
      "Use a long knife; a short knife will require multiple strokes and can slip."
    ],
    servingIdeas: ["fruit salad", "agua fresca", "grilled watermelon", "gazpacho", "summer punch"]
  },
  {
    name: "strawberry",
    aliases: ["strawberries"],
    emoji: "🍓",
    difficulty: "easy",
    tools: ["paring knife or chef's knife", "cutting board", "strawberry huller (optional)"],
    preparation: "Rinse strawberries under cold water before hulling (not after — they absorb water).",
    technique: "Hull then slice",
    steps: [
      { step: 1, instruction: "Hold the strawberry firmly and insert the tip of a paring knife at a 45° angle just outside the green hull." },
      { step: 2, instruction: "Rotate the strawberry while keeping the knife angled, cutting out a cone-shaped hull. Discard." },
      { step: 3, instruction: "Slice the berry lengthways into halves or quarters for salads, or into rounds for shortcake and tarts." },
      { step: 4, instruction: "For fans: make parallel slices from just below the hull to the tip, keeping the slices attached at the top, then fan out." }
    ],
    tips: [
      "A straw pushed through the bottom of the berry pops the hull out cleanly — no knife needed.",
      "Very large berries benefit from quartering so every bite has similar size.",
      "For macerated strawberries, slice and toss with sugar 20 minutes before serving."
    ],
    safetyNotes: [
      "Paring knives are small but very sharp — keep your thumb tucked when rotating.",
      "Don't hull strawberries and then wash them — they become waterlogged."
    ],
    servingIdeas: ["shortcake", "smoothies", "chocolate dip", "salad", "jam"]
  },
  {
    name: "kiwi",
    aliases: ["kiwifruit", "chinese gooseberry"],
    emoji: "🥝",
    difficulty: "easy",
    tools: ["paring knife or spoon", "cutting board"],
    preparation: "Rinse the kiwi. Check ripeness by gently squeezing — it should yield like a ripe peach.",
    technique: "Peel and slice, or scoop",
    steps: [
      { step: 1, instruction: "Option A (spoon method): Cut off both ends. Insert a large spoon between the skin and flesh and rotate it around the fruit — the flesh slides out whole." },
      { step: 2, instruction: "Option B (peel and slice): Slice off both ends. Use a paring knife or peeler to remove the skin in downward strokes following the curve." },
      { step: 3, instruction: "Slice the peeled kiwi into rounds, halves, or quarters as desired." },
      { step: 4, instruction: "For a decorative cut: score a zigzag around the equator and pull the two halves apart for a crown presentation." }
    ],
    tips: [
      "The spoon method is the quickest and wastes the least flesh.",
      "Kiwi skin is edible (and high in fibre) — just rub off the fuzz and eat it whole.",
      "Kiwi contains actinidin which tenderises meat — great in marinades."
    ],
    safetyNotes: [
      "The fruit is slippery once peeled — use a firm grip or towel.",
      "Kiwi can trigger oral allergy syndrome in people with birch pollen allergy."
    ],
    servingIdeas: ["fruit salad", "pavlova", "smoothies", "tart", "tropical sorbet"]
  },
  {
    name: "lemon",
    aliases: ["lime", "citrus", "limes", "lemons"],
    emoji: "🍋",
    difficulty: "easy",
    tools: ["chef's knife or paring knife", "cutting board", "citrus juicer (optional)"],
    preparation: "Roll the lemon firmly on the counter with your palm for 20–30 seconds before cutting — this breaks down the membranes and yields significantly more juice.",
    technique: "Depends on use: rounds, wedges, or juice",
    steps: [
      { step: 1, instruction: "For juice: cut the lemon in half across its equator (not through the poles). Squeeze or use a juicer." },
      { step: 2, instruction: "For wedges: cut in half through the poles, then cut each half into 3–4 wedges. Optional: make a slit across the flesh side for garnishing glasses." },
      { step: 3, instruction: "For rounds (wheels): slice crossways into thin rounds. Remove any visible seeds with the tip of the knife." },
      { step: 4, instruction: "For zest: use a microplane before cutting. Grate only the yellow outer layer — the white pith is bitter." }
    ],
    tips: [
      "Rolling before cutting is the single biggest yield improvement.",
      "Microwave for 15 seconds if you need maximum juice quickly.",
      "Store cut lemons cut-side down on a plate — they stay fresh longer."
    ],
    safetyNotes: [
      "Lemon juice in the eyes stings badly — don't cut toward your face.",
      "Lemon juice irritates skin cuts; use a towel."
    ],
    servingIdeas: ["cocktails", "salad dressing", "lemon curd", "marinades", "garnish"]
  },
  {
    name: "banana",
    aliases: ["bananas", "plantain"],
    emoji: "🍌",
    difficulty: "easy",
    tools: ["hands (for peeling)", "knife (optional for slicing)"],
    preparation: "Bananas peel best from the non-stem end — the way monkeys actually do it.",
    technique: "Peel from the bottom; slice as needed",
    steps: [
      { step: 1, instruction: "Snap off the brown tip at the non-stem end (opposite to the stem). Pinch and peel downward in strips." },
      { step: 2, instruction: "Alternatively, snap the stem end backward to split the peel open, then peel down." },
      { step: 3, instruction: "For rounds: place the peeled banana on a cutting board and slice crossways into coins." },
      { step: 4, instruction: "For a banana split: leave the peel on and make a lengthways cut through the top, stopping just before each end — then peel back the slit." },
      { step: 5, instruction: "For frozen banana preparation: slice into coins and freeze on a lined tray before bagging." }
    ],
    tips: [
      "The stringy bits (phloem bundles) are entirely edible.",
      "Overripe bananas are sweeter and better for baking; don't discard them.",
      "Toss banana slices in lemon juice if they won't be eaten immediately."
    ],
    safetyNotes: [
      "Banana peel on the floor is genuinely a slip hazard — bin it promptly.",
      "No knife safety concerns beyond the usual."
    ],
    servingIdeas: ["banana bread", "smoothies", "banana split", "cereal topping", "frozen nice cream"]
  },
  {
    name: "peach",
    aliases: ["nectarine", "peaches", "nectarines"],
    emoji: "🍑",
    difficulty: "medium",
    tools: ["chef's knife", "cutting board"],
    preparation: "Wash gently. Check the peach is ripe — it should smell fragrant and yield slightly at the stem end.",
    technique: "Score and twist (freestone) or slice around the pit (clingstone)",
    steps: [
      { step: 1, instruction: "Locate the seam that runs from stem to tip — this follows the pit inside." },
      { step: 2, instruction: "For freestone peaches: cut around the seam all the way through to the pit. Twist the two halves in opposite directions to separate. Pop out the pit with a spoon or fingers." },
      { step: 3, instruction: "For clingstone peaches: slice downward segments directly off the pit, rotating the fruit as you go." },
      { step: 4, instruction: "Peel if desired: score an X on the base, blanch in boiling water for 30 seconds, then transfer to ice water — the skin slips off." },
      { step: 5, instruction: "Slice each half or quarter into wedges. Toss with lemon juice immediately." }
    ],
    tips: [
      "Most peaches at peak season are freestone — clingstone varieties are more common early and late season.",
      "Grilling peach halves cut-side down for 3–4 minutes caramelises the sugar beautifully.",
      "The skin is edible and nutritious; only peel for refined dishes."
    ],
    safetyNotes: [
      "The pit is very hard — don't try to force the knife through it.",
      "Ripe peaches are slippery; grip firmly with a towel."
    ],
    servingIdeas: ["peach cobbler", "sangria", "grilling", "salsa", "jam", "bellini"]
  }
];

/**
 * Look up a fruit by name or alias (case-insensitive)
 */
export function findFruit(query: string): FruitEntry | undefined {
  const q = query.toLowerCase().trim();
  return FRUIT_DATABASE.find(
    (f) =>
      f.name === q ||
      f.aliases.some((a) => a === q) ||
      f.name.includes(q) ||
      q.includes(f.name)
  );
}

/**
 * List all fruit names in the database
 */
export function listFruits(): string[] {
  return FRUIT_DATABASE.map((f) => `${f.emoji} ${f.name}`);
}
