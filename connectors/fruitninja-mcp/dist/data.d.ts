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
export declare const FRUIT_DATABASE: FruitEntry[];
/**
 * Look up a fruit by name or alias (case-insensitive)
 */
export declare function findFruit(query: string): FruitEntry | undefined;
/**
 * List all fruit names in the database
 */
export declare function listFruits(): string[];
