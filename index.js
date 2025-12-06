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

function rollTable(tableName, breadcrumb = [], modifiers = []) {
  breadcrumb.push(tableName);

  const tablePath = path.join(__dirname, 'data', `${tableName}.json`);
  const tableData = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
  let selectedItem = weightedRandom(tableData);

  // If the selected item is a table, recursively roll on that table
  while (selectedItem.type === 'table') {
    breadcrumb.push(selectedItem.name);

    // If the selected item has a modifier, add it to the modifiers array
    if (selectedItem.modifier) {
      modifiers.push(selectedItem.modifier);
    }

    const nestedTablePath = path.join(__dirname, 'data', `${selectedItem.name}.json`);
    const nestedTableData = JSON.parse(fs.readFileSync(nestedTablePath, 'utf8'));
    selectedItem = weightedRandom(nestedTableData);
  }

  return { item: selectedItem, breadcrumb, modifiers };
}

// Parse command line arguments
const argv = minimist(process.argv.slice(2));
const originTable = argv.o || argv.origin || 'armor';

// Start by rolling on the specified origin table
const result = rollTable(originTable);

// Build the final item name with modifiers as prefix
const modifierPrefix = result.modifiers.length > 0 ? result.modifiers.join(' ') + ' ' : '';
const finalItemName = modifierPrefix + result.item.name;

// Output the breadcrumb trail and the selected item's name
console.log(`${result.breadcrumb.join(' > ')} > ${finalItemName}`);

