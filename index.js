#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

function weightedRandom(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const random = Math.floor(Math.random() * totalWeight);

  let currentWeight = 0;
  for (const item of items) {
    currentWeight += item.weight;
    if (random < currentWeight) {
      return item;
    }
  }
}

function rollTable(tableName, breadcrumb = [], modifiers = [], totalValue = 0, maxValue = null, userMaxValue = null) {
  breadcrumb.push(tableName);

  const tablePath = path.join(__dirname, 'data', `${tableName}.json`);
  const tableData = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
  let selectedItem = weightedRandom(tableData);

  // Check if user max value is exceeded by this selection's max_value
  if (userMaxValue && selectedItem.max_value && selectedItem.max_value > userMaxValue) {
    return { item: null, breadcrumb, modifiers, totalValue, maxValue, exceeded: true };
  }

  // If the selected item is a table, recursively roll on that table
  while (selectedItem.type === 'table') {
    breadcrumb.push(selectedItem.name);

    // If the selected item has a modifier, add it to the modifiers array
    if (selectedItem.modifier) {
      modifiers.push(selectedItem.modifier);
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
    selectedItem = weightedRandom(nestedTableData);
  }

  // Add the final item's value to the total
  if (selectedItem.value) {
    totalValue += selectedItem.value;
  }

  return { item: selectedItem, breadcrumb, modifiers, totalValue, maxValue, exceeded: false };
}

// Parse command line arguments
const argv = minimist(process.argv.slice(2));
const originTable = argv.o || argv.origin || 'armor';
const numberOfResults = argv.n || argv.number || 1;
const userMaxValue = argv.v || argv.value || null;

// Maximum number of reroll attempts to avoid infinite loops
const MAX_REROLL_ATTEMPTS = 100;

// Roll the specified number of times
for (let i = 0; i < numberOfResults; i++) {
  let result;
  let attempts = 0;

  // Keep rolling until we get a valid result (within max_value) or reach max attempts
  do {
    result = rollTable(originTable, [], [], 0, null, userMaxValue);
    attempts++;

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
    // If user set a max value and total exceeds it, reroll
    else if (userMaxValue && result.totalValue > userMaxValue) {
      shouldReroll = true;
    }

    if (shouldReroll) {
      if (attempts >= MAX_REROLL_ATTEMPTS) {
        // Give up after max attempts and use the last result
        const constraintValue = userMaxValue || result.maxValue;
        console.error(`Warning: Could not find item within max value (${constraintValue}gp) after ${MAX_REROLL_ATTEMPTS} attempts`);
        break;
      }
      // Otherwise continue the loop to reroll
    } else {
      // Valid result, break out of the loop
      break;
    }
  } while (true);

  // Only output if we have a valid item
  if (result.item) {
    // Build the final item name with modifiers as prefix
    const modifierPrefix = result.modifiers.length > 0 ? result.modifiers.join(' ') + ' ' : '';
    const finalItemName = `${modifierPrefix}${result.item.name} (${result.totalValue}gp)`;

    // Output the breadcrumb trail and the selected item's name
    console.log(`${result.breadcrumb.join(' > ')} > ${finalItemName}`);
  } else {
    console.error('Error: Could not generate a valid result');
  }
}

