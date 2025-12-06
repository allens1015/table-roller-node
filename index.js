#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

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

function rollTable(tableName) {
  const tablePath = path.join(__dirname, 'data', `${tableName}.json`);
  const tableData = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
  let selectedItem = weightedRandom(tableData);

  // If the selected item is a table, recursively roll on that table
  while (selectedItem.type === 'table') {
    const nestedTablePath = path.join(__dirname, 'data', `${selectedItem.name}.json`);
    const nestedTableData = JSON.parse(fs.readFileSync(nestedTablePath, 'utf8'));
    selectedItem = weightedRandom(nestedTableData);
  }

  return selectedItem;
}

// Start by rolling on armor.json
const selectedItem = rollTable('armor');

// Output the selected item's name
console.log(selectedItem.name);
