// Import required modules
const express = require("express");

// Create an Express application
const app = express();

// Define port (will use environment variable PORT if defined, otherwise default to 3000)
const port = process.env.PORT || 3000;

// Define a route for '/hello'
app.get("/hello", (req, res) => {
  res.send("Hello, World!");
});

// Define a route for the root path
app.get("/", (req, res) => {
  res.send("Welcome to the Express server! Try visiting /hello");
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
