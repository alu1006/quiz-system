const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://wrgsrmvctzfbmzbbyeuj.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndyZ3NybXZjdHpmYm16YmJ5ZXVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0Njc1NDksImV4cCI6MjA5MDA0MzU0OX0.sl-cMyyPoR-nUFxgRQP7HyaGNne7oXBqMFkK_yTXiaE';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
