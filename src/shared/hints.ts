/**
 * Generate hints (DECISIONS 112): small, text-only nudges towards what the tests found works.
 * Vehicles: the Car studio style keeps wheels and proportions right on both models (Klein drew wheels in the wrong
 * place without it); lettering on the picture is more reliable on Qwen-Image 2.1.
 */
const VEHICLE =
  /\b(cars?|automobiles?|vehicles?|trucks?|pick-?ups?|suvs?|crossovers?|sedans?|saloons?|coupes?|coupés?|hatchbacks?|roadsters?|convertibles?|jeeps?|overlanders?|4x4s?|off-roaders?|vans?|minivans?|buses|lorr(?:y|ies)|race ?cars?|supercars?|hypercars?|evs?|motorbikes?|motorcycles?|scooters?|tractors?)\b/i;

/** Does this prompt describe a road vehicle? */
export const describesVehicle = (prompt: string): boolean => VEHICLE.test(prompt);

/** Does this prompt ask for words on the picture (text in quotes, e.g. "OVERLANDER")? */
export const asksForLettering = (prompt: string): boolean => /["“”][^"“”]{2,40}["“”]/.test(prompt);
