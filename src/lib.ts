import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';

/**
 * Simple async pool to process promises with limited concurrency.
 *
 * @param items Array of items to process
 * @param limit Maximum number of concurrent executions
 * @param fn    Async function applied to each item
 * @returns Results in the same order as `items`
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid concurrency limit: ${limit}`);
  }

  const result: R[] = new Array(items.length);
  let index = 0;
  const workers = new Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (index < items.length) {
        const current = index++;
        result[current] = await fn(items[current]);
      }
    });
  await Promise.all(workers);
  return result;
}

/**
 * Parse a concurrency value and enforce sane defaults.
 * Values above {@link MAX_CONCURRENCY} are capped.
 * Returns the default value when invalid.
 */
export const MAX_CONCURRENCY = 100;

export function parseConcurrency(
  value: unknown,
  defaultVal = 10,
  max = MAX_CONCURRENCY,
): number {
  const parsed =
    typeof value === 'string'
      ? Number.parseInt(value, 10)
      : typeof value === 'number'
        ? value
        : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed, max);
  }
  return defaultVal;
}

// Type definitions shared with consumers
export interface SetInfo {
  /** Unique identifier of the set */
  id: string;
  /** Set name in multiple languages */
  name?: Record<string, string>;
  /** Number of cards in the set */
  cardCount?: { official: number };
  /** Mapping of booster IDs to booster info */
  boosters?: Record<string, { name: Record<string, string> }>;
  /** Release date as ISO string */
  releaseDate?: string;
  [key: string]: unknown;
}

export interface Card {
  /** Identifier of the set this card belongs to */
  set_id: string;
  /** List of booster IDs this card appears in */
  boosters?: string[];
  [key: string]: unknown;
}

const projectRoot = path.resolve(__dirname, '..');

/**
 * Resolve the tcgdex repository directory from the environment variable.
 *
 * @throws Error when the resolved path is outside the project or does not exist.
 */
export function resolveRepoDir(): string {
  const dir = path.resolve(process.env.TCGDEX_REPO || 'tcgdex');
  if (/\0|\n|\r/.test(dir)) {
    throw new Error('Ung\xC3\xBCltige Zeichen in TCGDEX_REPO');
  }
  const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  const relative = path.relative(projectRoot, realDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`TCGDEX_REPO muss im Projektordner liegen: ${dir}`);
  }
  if (!fs.existsSync(realDir)) {
    throw new Error(
      `Ordner '${dir}' nicht gefunden. Bitte tcgdex/cards-database hier klonen.`,
    );
  }
  return realDir;
}

export const repoDir = resolveRepoDir();

const SETS_GLOB = path.join(repoDir, 'data', 'Pokémon TCG Pocket', '*.ts');
const CARDS_GLOB = path.join(
  repoDir,
  'data',
  'Pokémon TCG Pocket',
  '*',
  '*.ts',
);

async function importTSFile(file: string) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(repoDir + path.sep)) {
    /* c8 ignore next */
    throw new Error(`Refusing to import outside of repo directory: ${file}`);
  }
  return await import(resolved);
}

/**
 * Read all set definition files and return them as plain objects.
 *
 * @param concurrency Maximum number of files loaded in parallel
 * @returns Array of `SetInfo` objects
 */
export async function getAllSets(
  concurrency = parseConcurrency(process.env.CONCURRENCY),
): Promise<SetInfo[]> {
  try {
    const setFiles = await glob(SETS_GLOB);

    const sets = await mapLimit(setFiles, concurrency, async (file) => {
      try {
        const set = (await importTSFile(file)).default;
        if (set.serie) {
          delete set.serie;
        }
        if (!set.name) {
          set.name = { en: path.basename(file, '.ts') };
        }
        return set as SetInfo;
      } catch (e) {
        /* c8 ignore next */
        throw new Error(
          `Failed to import set file ${file}: ${(e as Error).message}`,
        );
      }
    });
    return sets;
  } catch (e) {
    /* c8 ignore next */
    throw new Error(`Failed to load sets: ${(e as Error).message}`);
  }
}

/**
 * Load all card files and attach the corresponding set identifier.
 *
 * @param concurrency Maximum number of files loaded in parallel
 * @returns Array of `Card` objects
 */
export async function getAllCards(
  concurrency = parseConcurrency(process.env.CONCURRENCY),
): Promise<Card[]> {
  try {
    const files = await glob(CARDS_GLOB);

    const cards = await mapLimit(files, concurrency, async (file) => {
      try {
        const mod = await importTSFile(file);
        const card = mod.default || mod;

        let setId: string;
        if (card.set && card.set.id) {
          setId = card.set.id;
        } else {
          setId = path.basename(path.dirname(file));
        }
        card.set_id = setId;

        delete card.set;

        return card as Card;
      } catch (e) {
        /* c8 ignore next */
        throw new Error(
          `Failed to import card file ${file}: ${(e as Error).message}`,
        );
      }
    });
    return cards;
  } catch (e) {
    /* c8 ignore next */
    throw new Error(`Failed to load cards: ${(e as Error).message}`);
  }
}

/**
 * Write card and set data into JSON files within the given directory.
 *
 * @param cards Array of card objects to write
 * @param sets  Array of set objects to write
 * @param dataDir Output directory for the JSON files
 * @returns Paths of the written files for further processing
 */
export async function writeData(
  cards: Card[],
  sets: SetInfo[],
  dataDir = path.join(__dirname, '..', 'data'),
): Promise<{ cardsOutPath: string; setsOutPath: string }> {
  await fs.ensureDir(dataDir);

  const cardsOutPath = path.join(dataDir, 'cards.json');
  const setsOutPath = path.join(dataDir, 'sets.json');

  const cardsTmp = cardsOutPath + '.tmp';
  const setsTmp = setsOutPath + '.tmp';
  try {
    await fs.writeJson(cardsTmp, cards, { spaces: 2 });
    await fs.writeJson(setsTmp, sets, { spaces: 2 });
    await fs.move(cardsTmp, cardsOutPath, { overwrite: true });
    await fs.move(setsTmp, setsOutPath, { overwrite: true });
    return { cardsOutPath, setsOutPath };
  } catch (e) {
    await Promise.allSettled([fs.remove(cardsTmp), fs.remove(setsTmp)]);
    throw e;
  }
}
