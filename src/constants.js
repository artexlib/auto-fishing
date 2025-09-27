'use strict';

const ACTION_DELAY_THROW_ROD = [6023, 6798];
const ACTION_DELAY_FISH_START = [1345, 2656];
const ACTION_DELAY_FISH_CATCH = [5564, 15453];
const DELAY_BASED_ON_FISH_TIER = true;

const BAIT_RECIPES = [
  { name: 'Bait II', itemId: 206001, recipeId: 204100, wormId: 206006 },
  { name: 'Bait III', itemId: 206002, recipeId: 204101, wormId: 206007 },
  { name: 'Bait IV', itemId: 206003, recipeId: 204102, wormId: 206008 },
  { name: 'Bait V', itemId: 206004, recipeId: 204103, wormId: 206009 }
];

module.exports = {
  ACTION_DELAY_THROW_ROD,
  ACTION_DELAY_FISH_START,
  ACTION_DELAY_FISH_CATCH,
  DELAY_BASED_ON_FISH_TIER,
  BAIT_RECIPES
};
