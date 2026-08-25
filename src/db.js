// This file creates ONE connection to the database that the rest
// of the app reuses, instead of opening a new connection every time.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = prisma;
