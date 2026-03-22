// Expands a dish search into related terms for menu matching
// Only expands to genuinely related items — never unrelated food categories

function getDishWords(dish) {
  const base = dish.toLowerCase().split(' ').filter(w => w.length > 2);
  
  // Dish-specific expansions
  const expansions = {
    pizza: ['pizza', 'pie', 'pepperoni', 'margherita', 'sicilian', 'calzone', 'stromboli', 'flatbread'],
    burger: ['burger', 'cheeseburger', 'hamburger', 'smash', 'patty'],
    chicken: ['chicken', 'poultry', 'wings', 'tenders', 'nuggets', 'grilled chicken'],
    soup: ['soup', 'broth', 'bisque', 'chowder', 'stew'],
    salad: ['salad', 'greens', 'caesar', 'cobb'],
    sandwich: ['sandwich', 'sub', 'hoagie', 'hero', 'panini', 'wrap', 'grinder'],
    pasta: ['pasta', 'spaghetti', 'penne', 'rigatoni', 'fettuccine', 'linguine', 'lasagna', 'ravioli'],
    sushi: ['sushi', 'roll', 'maki', 'sashimi', 'nigiri'],
    tacos: ['taco', 'burrito', 'quesadilla', 'enchilada', 'fajita'],
    wings: ['wing', 'wings', 'chicken wing'],
    steak: ['steak', 'ribeye', 'sirloin', 'filet', 'strip'],
  };

  // Find which expansion categories apply to this dish
  let expanded = [...base];
  for (const [key, words] of Object.entries(expansions)) {
    if (base.some(w => key.includes(w) || w.includes(key))) {
      expanded = [...new Set([...expanded, ...words])];
      break;
    }
  }
  
  // If still just base words (no expansion matched), try partial matches
  if (expanded.length === base.length) {
    for (const [key, words] of Object.entries(expansions)) {
      if (base.some(w => words.some(ew => ew.includes(w) || w.includes(ew)))) {
        expanded = [...new Set([...expanded, ...words])];
        break;
      }
    }
  }

  return expanded;
}

module.exports = { getDishWords };
