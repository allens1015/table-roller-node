#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

// Global configuration object to store command-line flags and settings
const config = {
  userMaxValue: null,        // The budget for accumulating items (-v value)
  filterMaxValue: null,       // The max_value tier to select from (also -v value when --max is set)
  actualSetMaxValue: null,    // The actual max_value of the selected set (found after filtering)
  rareChance: 10,
  uncommonChance: 20,
};

// Function to parse and roll dice notation (e.g., "2d4", "1d6", "3d10")
// Supports arithmetic operations: "2d4*10", "2d4/10", etc.
function rollDice(notation) {
  if (typeof notation !== 'string') {
    return notation; // If it's already a number, return it
  }

  // Check for multiplication (e.g., "2d4*10")
  const multMatch = notation.match(/^(\d+d\d+)\s*\*\s*(\d+(?:\.\d+)?)$/i);
  if (multMatch) {
    const [, diceNotation, multiplier] = multMatch;
    const baseRoll = rollDice(diceNotation); // Recursive call
    return baseRoll * parseFloat(multiplier);
  }

  // Check for division (e.g., "2d4/10")
  const divMatch = notation.match(/^(\d+d\d+)\s*\/\s*(\d+(?:\.\d+)?)$/i);
  if (divMatch) {
    const [, diceNotation, divisor] = divMatch;
    const baseRoll = rollDice(diceNotation); // Recursive call
    return baseRoll / parseFloat(divisor);
  }

  // Original dice notation parsing
  const match = notation.match(/^(\d+)d(\d+)$/i);
  if (!match) {
    // Not a valid dice notation, try to parse as number
    const parsed = parseFloat(notation);
    return isNaN(parsed) ? 0 : parsed;
  }

  const [, numDice, dieSize] = match;
  const count = parseInt(numDice, 10);
  const sides = parseInt(dieSize, 10);

  let total = 0;
  for (let i = 0; i < count; i++) {
    total += Math.floor(Math.random() * sides) + 1;
  }

  return total;
}

function weightedRandom(items, allowedRarities = ['common', 'uncommon', 'rare']) {
  // Filter items based on allowed rarities (assume 'common' if no rarity property)
  // Arrays and objects with 'items' property are always included (they represent sets of items)
  const filteredItems = items.filter(item => {
    // If it's an array (a set of items), always include it
    if (Array.isArray(item)) {
      return true;
    }
    // If it's an object with 'items' property (weighted set), always include it
    if (item.items && Array.isArray(item.items)) {
      return true;
    }
    const rarity = item.rarity || 'common';
    return allowedRarities.includes(rarity);
  });

  // If filterMaxValue is set, also filter by items that have matching max_value in nested tables
  // This is only relevant for table references (type:"table")
  if (config.filterMaxValue !== null && filteredItems.length > 0) {
    // Check if any items are table references
    const hasTableReferences = filteredItems.some(item => item.type === 'table' && !item.items);
    if (hasTableReferences) {
      // For table references, we want to keep them all and let the nested rollTable handle filtering
      // So we don't filter here, just pass through
    }
  }

  // If no items match the allowed rarities, fall back to all items
  const itemsToUse = filteredItems.length > 0 ? filteredItems : items;

  // Calculate total weight
  const totalWeight = itemsToUse.reduce((sum, item) => {
    if (Array.isArray(item)) {
      // For bare arrays, use weight 1 as default
      return sum + 1;
    }
    // For objects with 'items' property or regular items, use their weight (default to 1 if not specified)
    return sum + (item.weight || 1);
  }, 0);

  const random = Math.floor(Math.random() * totalWeight);

  let currentWeight = 0;
  for (const item of itemsToUse) {
    const itemWeight = Array.isArray(item) ? 1 : (item.weight || 1);
    currentWeight += itemWeight;
    if (random < currentWeight) {
      return item;
    }
  }
}

// Helper function to process a single selected item through tables and modifiers
function processSelectedItem(selectedItem, breadcrumb, modifiers, totalValue, maxValue, finalItemTable) {
  // Check if user max value is exceeded by this selection's max_value or min_value
  if (config.userMaxValue && selectedItem.max_value && selectedItem.max_value > config.userMaxValue) {
    return { item: null, breadcrumb, modifiers, totalValue, maxValue, exceeded: true, finalItemTable };
  }
  if (config.userMaxValue !== null && selectedItem.min_value && selectedItem.min_value > config.userMaxValue) {
    return { item: null, breadcrumb, modifiers, totalValue, maxValue, exceeded: true, finalItemTable };
  }

  // Track modifiers that need special processing (like special_materials)
  const pendingSpecialModifiers = [];

  // If the selected item is a table, recursively roll on that table
  while (selectedItem.type === 'table') {
    breadcrumb.push(selectedItem.name);

    // If the selected item has a modifier, add it to the modifiers array
    if (selectedItem.modifier) {
      // Handle both string and array modifiers
      const modifierArray = Array.isArray(selectedItem.modifier) ? selectedItem.modifier : [selectedItem.modifier];

      for (const mod of modifierArray) {
        if (mod === 'special_materials') {
          // Store special_materials for later processing
          pendingSpecialModifiers.push(mod);
        } else {
          modifiers.push(mod);
        }
      }
    }

    // Add the value of items with modifiers to the total
    if (selectedItem.modifier && selectedItem.value) {
      totalValue += rollDice(selectedItem.value);
    }

    // If this item has a max_value, set it for validation later
    if (selectedItem.max_value) {
      maxValue = selectedItem.max_value;
    }

    // Track which table we're about to roll on - this becomes our finalItemTable
    finalItemTable = selectedItem.name;

    // Recursively roll on the nested table
    // This ensures that filterMaxValue is applied to nested tables too
    // Pass empty breadcrumb since rollTable will add the table name
    const nestedResult = rollTable(selectedItem.name, breadcrumb.slice(), modifiers, totalValue, maxValue, finalItemTable);

    // If it's a set, we need to handle it differently - just return the set result
    if (nestedResult.isSet) {
      return nestedResult;
    }

    // Otherwise, use the nested result's item
    selectedItem = nestedResult.item;
    breadcrumb = nestedResult.breadcrumb;
    modifiers = nestedResult.modifiers;
    totalValue = nestedResult.totalValue;
    maxValue = nestedResult.maxValue;
    finalItemTable = nestedResult.finalItemTable;
    break; // Exit the while loop since we've fully resolved this item
  }

  // Add the final item's value to the total
  // Support dice notation (e.g., "2d4") or numeric values
  if (selectedItem.value) {
    let rolledValue;

    // Handle display_value for showing different units (e.g., silver, copper)
    // If display_value exists, roll it and calculate gold value from the rolled display quantity
    if (selectedItem.display_value) {
      selectedItem.displayQuantity = rollDice(selectedItem.display_value);
      // Calculate the actual gold value by dividing the display quantity appropriately
      // For silver: displayQuantity / 10, for copper: displayQuantity / 100
      rolledValue = selectedItem.displayQuantity / 10; // Default: silver conversion
      if (selectedItem.name.toLowerCase().includes('copper')) {
        rolledValue = selectedItem.displayQuantity / 100;
      } else if (selectedItem.name.toLowerCase().includes('platinum')) {
        rolledValue = selectedItem.displayQuantity * 10;
      }
    } else {
      rolledValue = rollDice(selectedItem.value);
    }

    totalValue += rolledValue;
    selectedItem.rolledValue = rolledValue;
  }

  // Process special_materials modifiers now that we know the final item table
  let materialMultiplier = 1;
  for (const specialMod of pendingSpecialModifiers) {
    if (specialMod === 'special_materials' && finalItemTable) {
      const specialMaterialsPath = path.join(__dirname, 'data', 'special_materials.json');
      const specialMaterialsData = JSON.parse(fs.readFileSync(specialMaterialsPath, 'utf8'));

      // Filter materials that can be applied to this item type
      const compatibleMaterials = specialMaterialsData.filter(material => {
        return typeof material.value === 'object' && finalItemTable in material.value;
      });

      // If there are compatible materials, select one
      if (compatibleMaterials.length > 0) {
        const selectedMaterial = weightedRandom(compatibleMaterials);
        modifiers.push(selectedMaterial.name);

        // Get the material's value for this specific item type
        const materialValue = selectedMaterial.value[finalItemTable] || null;

        // Check if it's a multiplier or a fixed value
        if (materialValue !== null) {
          if (typeof materialValue === 'string' && materialValue.endsWith('x')) {
            // Multiplier format (e.g., "2x", "1.5x") - save for later
            materialMultiplier = parseFloat(materialValue.slice(0, -1));
          } else if (typeof materialValue === 'number') {
            // Fixed value to add immediately
            totalValue += materialValue;
          }
        }
      }
    }
  }

  // Apply multiplier at the very end, after all additions
  if (materialMultiplier !== 1) {
    totalValue = Math.floor(totalValue * materialMultiplier);
  }

  return { item: selectedItem, breadcrumb, modifiers, totalValue, maxValue, exceeded: false, finalItemTable };
}

function rollTable(tableName, breadcrumb = [], modifiers = [], totalValue = 0, maxValue = null, finalItemTable = null) {
  // Only add to breadcrumb if it's not already the last entry (avoid duplicates)
  if (breadcrumb.length === 0 || breadcrumb[breadcrumb.length - 1] !== tableName) {
    breadcrumb.push(tableName);
  }

  const tablePath = path.join(__dirname, 'data', `${tableName}.json`);
  let tableData = JSON.parse(fs.readFileSync(tablePath, 'utf8'));

  // Filter by max_value if specified (using global config)
  if (config.filterMaxValue !== null) {
    // Find all items with max_value <= filterMaxValue
    const validItems = tableData.filter(item => {
      return item.max_value && item.max_value <= config.filterMaxValue;
    });

    if (validItems.length > 0) {
      // Find the highest max_value among valid items (closest to filterMaxValue)
      const closestMaxValue = Math.max(...validItems.map(item => item.max_value));
      config.actualSetMaxValue = closestMaxValue;  // Store the actual tier selected
      // Filter to only items with that max_value
      tableData = validItems.filter(item => item.max_value === closestMaxValue);
    }
  }

  // Determine allowed rarities based on random roll (using global config)
  // Each rarity gets an exclusive percentage chance
  const rarityRoll = Math.random() * 100;
  let allowedRarities = ['common'];
  if (rarityRoll < config.rareChance) {
    // Rare chance: only rare items
    allowedRarities = ['rare'];
  } else if (rarityRoll < config.rareChance + config.uncommonChance) {
    // Uncommon chance: only uncommon items
    allowedRarities = ['uncommon'];
  } else {
    // Common chance: only common items (remaining percentage)
    allowedRarities = ['common'];
  }

  let selectedItem = weightedRandom(tableData, allowedRarities);

  // Check if the selected item is an array (set of items to generate)
  // or an object with an 'items' property (weighted set)
  let itemsToProcess = null;

  if (Array.isArray(selectedItem)) {
    // Bare array - use it directly
    itemsToProcess = selectedItem;
  } else if (selectedItem.items && Array.isArray(selectedItem.items)) {
    // Object with 'items' property - extract the array
    itemsToProcess = selectedItem.items;
  }

  if (itemsToProcess) {
    // Process each item in the set and return multiple results
    const setResults = [];
    let setTotalValue = 0;

    for (const itemInSet of itemsToProcess) {
      // Process this item as if it were selected directly
      const itemResult = processSelectedItem(itemInSet, breadcrumb.slice(), modifiers.slice(), totalValue, maxValue, finalItemTable);
      if (itemResult) {
        setResults.push(itemResult);
        setTotalValue += itemResult.totalValue;
      }
    }

    // Check if the wrapper object has a max_value for the entire set
    // When userMaxValue is higher than the set's max_value, allow the set to exceed its tier up to the userMaxValue
    // This enables selecting a lower tier (e.g., 500) but using a higher budget (e.g., 600) for that tier's items
    const effectiveLimit = (config.userMaxValue && config.userMaxValue > selectedItem.max_value)
      ? config.userMaxValue
      : selectedItem.max_value;

    if (selectedItem.max_value && setTotalValue > effectiveLimit) {
      // The total set value exceeds the effective limit, mark as exceeded
      return { isSet: true, setResults: [], exceeded: true, maxValue: selectedItem.max_value };
    }

    // Return a special marker indicating this is a set of results
    return { isSet: true, setResults };
  }

  // Process the single selected item
  return processSelectedItem(selectedItem, breadcrumb, modifiers, totalValue, maxValue, finalItemTable);
}

// Parse command line arguments
const argv = minimist(process.argv.slice(2));
const originTable = argv.o || argv.origin || 'armor';
const numberOfResults = argv.n || argv.number || 1;

// Populate global config object
config.userMaxValue = argv.v || argv.value || null;
config.rareChance = argv.r || argv.rare || 10;  // Default 10%
config.uncommonChance = argv.u || argv.uncommon || 20;  // Default 20%
const useMaxFilter = argv.max !== undefined;  // Whether to filter by max_value
config.filterMaxValue = useMaxFilter ? config.userMaxValue : null;  // Use userMaxValue for filtering when --max is set

// Maximum number of reroll attempts to avoid infinite loops
const MAX_REROLL_ATTEMPTS = 1000;
// Hard limit on total items output
const MAX_ITEMS_OUTPUT = 100;

// Determine target number of items and how many result sets
// If -v is set, we create ONE result set with multiple items
// If -v is NOT set, we create multiple result sets (one item each)
const createMultipleResultSets = !config.userMaxValue;
const numResultSets = createMultipleResultSets ? Math.min(numberOfResults, MAX_ITEMS_OUTPUT) : 1;
// When -v is set: if -n is also set, use -n as target, otherwise use MAX to fill budget
// When -v is NOT set: just use 1 item per result set
const targetItemCount = config.userMaxValue
  ? (numberOfResults > 1 ? Math.min(numberOfResults, MAX_ITEMS_OUTPUT) : Math.min(MAX_REROLL_ATTEMPTS, MAX_ITEMS_OUTPUT))
  : 1;

// Roll the specified number of times
for (let i = 0; i < numResultSets; i++) {
  const results = [];
  let accumulatedValue = 0;
  let attempts = 0;
  let setRollCount = 0; // Track how many times we've rolled the entire set

  // Keep rolling and accumulating items until we can't add more without exceeding the limit
  while (true) {
    let result;
    let rollAttempts = 0;

    // Try to roll a single item (or set of items) that fits within remaining budget
    do {
      const remainingBudget = config.userMaxValue ? config.userMaxValue - accumulatedValue : null;
      result = rollTable(originTable, [], [], 0, null, null);
      rollAttempts++;

      // Check if we need to reroll
      let shouldReroll = false;

      // If this is a set of results, check if any item in the set needs rerolling
      if (result.isSet) {
        // Check if the set itself was marked as exceeded (wrapper's max_value exceeded)
        if (result.exceeded) {
          shouldReroll = true;
        } else {
          // Check if any item in the set exceeds constraints
          let totalSetValue = 0;
          let setExceeded = false;

          for (const setItem of result.setResults) {
            if (setItem.exceeded) {
              setExceeded = true;
              break;
            }
            if (setItem.maxValue && setItem.totalValue > setItem.maxValue) {
              setExceeded = true;
              break;
            }
            totalSetValue += setItem.totalValue;
          }

          if (setExceeded || (remainingBudget !== null && totalSetValue > remainingBudget)) {
            shouldReroll = true;
          }
        }
      } else {
        // Single item - existing logic
        if (result.exceeded) {
          shouldReroll = true;
        }
        else if (result.maxValue && result.totalValue > result.maxValue) {
          shouldReroll = true;
        }
        else if (remainingBudget !== null && result.totalValue > remainingBudget) {
          shouldReroll = true;
        }
      }

      if (shouldReroll) {
        if (rollAttempts >= MAX_REROLL_ATTEMPTS) {
          // Give up after max attempts
          result = null;
          break;
        }
        // Otherwise continue the loop to reroll
      } else {
        // Valid result, break out of the loop
        break;
      }
    } while (true);

    // If we couldn't find a valid item, stop trying to add more
    if (!result || (result.isSet && result.setResults.length === 0) || (!result.isSet && !result.item)) {
      break;
    }

    // Add this result to our collection
    if (result.isSet) {
      // Add all items from the set, marking them with the current set roll count
      for (const setItem of result.setResults) {
        setItem.setIndex = setRollCount;
        results.push(setItem);
        accumulatedValue += setItem.totalValue;
        attempts++;
      }
      setRollCount++; // Increment after adding a complete set
    } else {
      // Add single item
      result.setIndex = setRollCount;
      results.push(result);
      accumulatedValue += result.totalValue;
      attempts++;
      setRollCount++; // Increment for single items too
    }

    // Stop conditions:
    // 1. If no user max value is set, stop after one item
    // 2. If we've reached the target item count
    // 3. If we've hit the safety limit
    if (!config.userMaxValue || attempts >= targetItemCount || attempts >= MAX_REROLL_ATTEMPTS) {
      break;
    }
  }

  // Output all results
  if (results.length > 0) {
    // Track set boundaries for visual separation
    let currentSetIndex = 0;

    for (let idx = 0; idx < results.length; idx++) {
      const result = results[idx];

      // Check if we need to insert a separator (when setIndex changes)
      if (result.setIndex !== undefined && result.setIndex > currentSetIndex) {
        console.log('---'); // Separator between sets
        currentSetIndex = result.setIndex;
      }

      // Build the final item name with modifiers as prefix
      const modifierPrefix = result.modifiers.length > 0 ? result.modifiers.join(' ') + ' ' : '';

      // Add rarity to the output if it's uncommon or rare
      const itemRarity = result.item.rarity || 'common';
      const rarityText = (itemRarity === 'uncommon' || itemRarity === 'rare') ? ` (${itemRarity})` : '';

      // Handle dice notation display - put it before the item name
      let itemNameWithDice = result.item.name;
      let valueDisplay = `${result.totalValue}gp`;

      // If there's a display quantity (for currencies like silver), show the conversion
      if (result.item.displayQuantity !== undefined && result.item.display_value) {
        itemNameWithDice = `${result.item.display_value} ${result.item.name}`;
        // Determine the currency unit based on the name
        let unitAbbrev = 'sp'; // Default to silver pieces
        if (result.item.name.toLowerCase().includes('copper')) {
          unitAbbrev = 'cp';
        } else if (result.item.name.toLowerCase().includes('platinum')) {
          unitAbbrev = 'pp';
        } else if (result.item.name.toLowerCase().includes('gold')) {
          unitAbbrev = 'gp';
        }
        valueDisplay = `${result.item.displayQuantity}${unitAbbrev} > ${result.totalValue}gp`;
      }
      // Otherwise show the dice notation if it was rolled
      else if (result.item.rolledValue !== undefined && typeof result.item.value === 'string' && result.item.value.match(/\d+d\d+/i)) {
        // Show the full expression (including *, /, etc.) before the item name
        itemNameWithDice = `${result.item.value} ${result.item.name}`;
      }

      const finalItemName = `${modifierPrefix}${itemNameWithDice} (${valueDisplay})${rarityText}`;

      // Output the breadcrumb trail and the selected item's name
      console.log(`${result.breadcrumb.join(' > ')} > ${finalItemName}`);
    }

    // Output total if multiple items were rolled
    if (config.userMaxValue && results.length > 1) {
      console.log(`Total: ${accumulatedValue}gp / ${config.userMaxValue}gp (${results.length} items)`);
    }
  } else {
    console.error('Error: Could not generate a valid result');
  }
}

