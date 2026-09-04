const { spawn } = require('child_process');

console.log('Starting Server and Dahua Connector...');

// Start the main server
const server = spawn('node', ['server.js'], { stdio: 'inherit' });

// Start the local connector
const connector = spawn('node', ['dahua-local-connector.js'], { stdio: 'inherit' });

// Handle termination gracefully
process.on('SIGINT', () => {
    console.log('\nShutting down both processes...');
    server.kill('SIGINT');
    connector.kill('SIGINT');
    process.exit(0);
});

// Handle child process exits
server.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
});

connector.on('close', (code) => {
    console.log(`Dahua connector process exited with code ${code}`);
});
