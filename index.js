#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

function weightedRandom(items, allowedRarities = ['common', 'uncommon', 'rare']) {
  // Filter items based on allowed rarities (assume 'common' if no rarity property)
  const filteredItems = items.filter(item => {
    const rarity = item.rarity || 'common';
    return allowedRarities.includes(rarity);
  });

  // If no items match the allowed rarities, fall back to all items
  const itemsToUse = filteredItems.length > 0 ? filteredItems : items;

  const totalWeight = itemsToUse.reduce((sum, item) => sum + item.weight, 0);
  const random = Math.floor(Math.random() * totalWeight);

  let currentWeight = 0;
  for (const item of itemsToUse) {
    currentWeight += item.weight;
    if (random < currentWeight) {
      return item;
    }
  }
}

function rollTable(tableName, breadcrumb = [], modifiers = [], totalValue = 0, maxValue = null, userMaxValue = null, finalItemTable = null) {
  breadcrumb.push(tableName);

  const tablePath = path.join(__dirname, 'data', `${tableName}.json`);
  const tableData = JSON.parse(fs.readFileSync(tablePath, 'utf8'));

  // Determine allowed rarities based on random roll (10% rare, 20% uncommon, always common)
  const rarityRoll = Math.random() * 100;
  let allowedRarities = ['common'];
  if (rarityRoll < 10) {
    // 10% chance: can pick rare, uncommon, or common
    allowedRarities = ['common', 'uncommon', 'rare'];
  } else if (rarityRoll < 30) {
    // 20% chance (10-30): can pick uncommon or common
    allowedRarities = ['common', 'uncommon'];
  }
  // Otherwise: only common (70% chance)

  let selectedItem = weightedRandom(tableData, allowedRarities);

  // Check if user max value is exceeded by this selection's max_value
  if (userMaxValue && selectedItem.max_value && selectedItem.max_value > userMaxValue) {
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
  for (const specialMod of pendingSpecialModifiers) {
    if (specialMod === 'special_materials' && finalItemTable) {
      const specialMaterialsPath = path.join(__dirname, 'data', 'special_materials.json');
      const specialMaterialsData = JSON.parse(fs.readFileSync(specialMaterialsPath, 'utf8'));

      // Filter materials that can be applied to this item type
      const compatibleMaterials = specialMaterialsData.filter(material => {
        // Handle both array of objects and single object formats
        if (Array.isArray(material.value)) {
          return material.value.some(valueObj => finalItemTable in valueObj);
        } else if (typeof material.value === 'object') {
          return finalItemTable in material.value;
        }
        return false;
      });

      // If there are compatible materials, select one
      if (compatibleMaterials.length > 0) {
        const selectedMaterial = weightedRandom(compatibleMaterials);
        modifiers.push(selectedMaterial.name);

        // Add the material's value for this specific item type
        let materialValue = 0;
        if (Array.isArray(selectedMaterial.value)) {
          const valueObj = selectedMaterial.value.find(obj => finalItemTable in obj);
          materialValue = valueObj ? valueObj[finalItemTable] : 0;
        } else if (typeof selectedMaterial.value === 'object') {
          materialValue = selectedMaterial.value[finalItemTable] || 0;
        }
        totalValue += materialValue;
      }
    }
  }

  return { item: selectedItem, breadcrumb, modifiers, totalValue, maxValue, exceeded: false, finalItemTable };
}

// Parse command line arguments
const argv = minimist(process.argv.slice(2));
const originTable = argv.o || argv.origin || 'armor';
const numberOfResults = argv.n || argv.number || 1;
const userMaxValue = argv.v || argv.value || null;

// Maximum number of reroll attempts to avoid infinite loops
const MAX_REROLL_ATTEMPTS = 100;

// Determine target number of items and how many result sets
// If -v is set, we create ONE result set with multiple items
// If -v is NOT set, we create multiple result sets (one item each)
const createMultipleResultSets = !userMaxValue;
const numResultSets = createMultipleResultSets ? numberOfResults : 1;
// When -v is set: if -n is also set, use -n as target, otherwise use MAX to fill budget
// When -v is NOT set: just use 1 item per result set
const targetItemCount = userMaxValue
  ? (numberOfResults > 1 ? numberOfResults : MAX_REROLL_ATTEMPTS)
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

    // Try to roll a single item that fits within remaining budget
    do {
      const remainingBudget = userMaxValue ? userMaxValue - accumulatedValue : null;
      result = rollTable(originTable, [], [], 0, null, remainingBudget, null);
      rollAttempts++;

      // Check if we need to reroll
      let shouldReroll = false;

      // If user set a max value and the selection was rejected, reroll
      if (result.exceeded) {
        shouldReroll = true;
      }
      // If there's a max_value constraint and we've exceeded it, reroll
      else if (result.maxValue && result.totalValue > result.maxValue) {
        shouldReroll = true;
      }
      // If user set a max value and total would exceed it, reroll
      else if (remainingBudget && result.totalValue > remainingBudget) {
        shouldReroll = true;
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
    if (!result || !result.item) {
      break;
    }

    // Add this result to our collection
    results.push(result);
    accumulatedValue += result.totalValue;
    attempts++;

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

