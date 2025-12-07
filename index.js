#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

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

  // If no items match the allowed rarities, fall back to all items
  const itemsToUse = filteredItems.length > 0 ? filteredItems : items;

  // Calculate total weight
  const totalWeight = itemsToUse.reduce((sum, item) => {
    if (Array.isArray(item)) {
      // For bare arrays, use weight 1 as default
      return sum + 1;
    }
    // For objects with 'items' property or regular items, use their weight
    return sum + item.weight;
  }, 0);

  const random = Math.floor(Math.random() * totalWeight);

  let currentWeight = 0;
  for (const item of itemsToUse) {
    const itemWeight = Array.isArray(item) ? 1 : item.weight;
    currentWeight += itemWeight;
    if (random < currentWeight) {
      return item;
    }
  }
}

// Helper function to process a single selected item through tables and modifiers
function processSelectedItem(selectedItem, breadcrumb, modifiers, totalValue, maxValue, userMaxValue, finalItemTable, allowedRarities) {
  // Check if user max value is exceeded by this selection's max_value or min_value
  if (userMaxValue && selectedItem.max_value && selectedItem.max_value > userMaxValue) {
    return { item: null, breadcrumb, modifiers, totalValue, maxValue, exceeded: true, finalItemTable };
  }
  if (userMaxValue !== null && selectedItem.min_value && selectedItem.min_value > userMaxValue) {
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
      totalValue += selectedItem.value;
    }

    // If this item has a max_value, set it for validation later
    if (selectedItem.max_value) {
      maxValue = selectedItem.max_value;
    }

    const nestedTablePath = path.join(__dirname, 'data', `${selectedItem.name}.json`);
    const nestedTableData = JSON.parse(fs.readFileSync(nestedTablePath, 'utf8'));

    // Track which table we're about to roll on - this becomes our finalItemTable
    finalItemTable = selectedItem.name;

    selectedItem = weightedRandom(nestedTableData, allowedRarities);
  }

  // Add the final item's value to the total
  if (selectedItem.value) {
    totalValue += selectedItem.value;
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

function rollTable(tableName, breadcrumb = [], modifiers = [], totalValue = 0, maxValue = null, userMaxValue = null, finalItemTable = null, rareChance = 10, uncommonChance = 20) {
  breadcrumb.push(tableName);

  const tablePath = path.join(__dirname, 'data', `${tableName}.json`);
  const tableData = JSON.parse(fs.readFileSync(tablePath, 'utf8'));

  // Determine allowed rarities based on random roll
  // Each rarity gets an exclusive percentage chance
  const rarityRoll = Math.random() * 100;
  let allowedRarities = ['common'];
  if (rarityRoll < rareChance) {
    // Rare chance: only rare items
    allowedRarities = ['rare'];
  } else if (rarityRoll < rareChance + uncommonChance) {
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
    for (const itemInSet of itemsToProcess) {
      // Process this item as if it were selected directly
      const itemResult = processSelectedItem(itemInSet, breadcrumb.slice(), modifiers.slice(), totalValue, maxValue, userMaxValue, finalItemTable, allowedRarities);
      if (itemResult) {
        setResults.push(itemResult);
      }
    }
    // Return a special marker indicating this is a set of results
    return { isSet: true, setResults };
  }

  // Process the single selected item
  return processSelectedItem(selectedItem, breadcrumb, modifiers, totalValue, maxValue, userMaxValue, finalItemTable, allowedRarities);
}

// Parse command line arguments
const argv = minimist(process.argv.slice(2));
const originTable = argv.o || argv.origin || 'armor';
const numberOfResults = argv.n || argv.number || 1;
const userMaxValue = argv.v || argv.value || null;
const rareChance = argv.r || argv.rare || 10;  // Default 10%
const uncommonChance = argv.u || argv.uncommon || 20;  // Default 20%

// Maximum number of reroll attempts to avoid infinite loops
const MAX_REROLL_ATTEMPTS = 100;
// Hard limit on total items output
const MAX_ITEMS_OUTPUT = 100;

// Determine target number of items and how many result sets
// If -v is set, we create ONE result set with multiple items
// If -v is NOT set, we create multiple result sets (one item each)
const createMultipleResultSets = !userMaxValue;
const numResultSets = createMultipleResultSets ? Math.min(numberOfResults, MAX_ITEMS_OUTPUT) : 1;
// When -v is set: if -n is also set, use -n as target, otherwise use MAX to fill budget
// When -v is NOT set: just use 1 item per result set
const targetItemCount = userMaxValue
  ? (numberOfResults > 1 ? Math.min(numberOfResults, MAX_ITEMS_OUTPUT) : Math.min(MAX_REROLL_ATTEMPTS, MAX_ITEMS_OUTPUT))
  : 1;

// Roll the specified number of times
for (let i = 0; i < numResultSets; i++) {
  const results = [];
  let accumulatedValue = 0;
  let attempts = 0;

  // Keep rolling and accumulating items until we can't add more without exceeding the limit
  while (true) {
    let result;
    let rollAttempts = 0;

    // Try to roll a single item (or set of items) that fits within remaining budget
    do {
      const remainingBudget = userMaxValue ? userMaxValue - accumulatedValue : null;
      result = rollTable(originTable, [], [], 0, null, remainingBudget, null, rareChance, uncommonChance);
      rollAttempts++;

      // Check if we need to reroll
      let shouldReroll = false;

      // If this is a set of results, check if any item in the set needs rerolling
      if (result.isSet) {
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

        if (setExceeded || (remainingBudget && totalSetValue > remainingBudget)) {
          shouldReroll = true;
        }
      } else {
        // Single item - existing logic
        if (result.exceeded) {
          shouldReroll = true;
        }
        else if (result.maxValue && result.totalValue > result.maxValue) {
          shouldReroll = true;
        }
        else if (remainingBudget && result.totalValue > remainingBudget) {
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
      // Add all items from the set
      for (const setItem of result.setResults) {
        results.push(setItem);
        accumulatedValue += setItem.totalValue;
        attempts++;
      }
    } else {
      // Add single item
      results.push(result);
      accumulatedValue += result.totalValue;
      attempts++;
    }

    // Stop conditions:
    // 1. If no user max value is set, stop after one item
    // 2. If we've reached the target item count
    // 3. If we've hit the safety limit
    if (!userMaxValue || attempts >= targetItemCount || attempts >= MAX_REROLL_ATTEMPTS) {
      break;
    }
  }

  // Output all results
  if (results.length > 0) {
    for (const result of results) {
      // Build the final item name with modifiers as prefix
      const modifierPrefix = result.modifiers.length > 0 ? result.modifiers.join(' ') + ' ' : '';

      // Add rarity to the output if it's uncommon or rare
      const itemRarity = result.item.rarity || 'common';
      const rarityText = (itemRarity === 'uncommon' || itemRarity === 'rare') ? ` (${itemRarity})` : '';

      const finalItemName = `${modifierPrefix}${result.item.name} (${result.totalValue}gp)${rarityText}`;

      // Output the breadcrumb trail and the selected item's name
      console.log(`${result.breadcrumb.join(' > ')} > ${finalItemName}`);
    }

    // Output total if multiple items were rolled
    if (userMaxValue && results.length > 1) {
      console.log(`Total: ${accumulatedValue}gp / ${userMaxValue}gp (${results.length} items)`);
    }
  } else {
    console.error('Error: Could not generate a valid result');
  }
}

