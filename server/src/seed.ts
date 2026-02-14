import prisma from './config/database';

async function seed() {
  console.log('Seeding database...');

  // Create demo project
  const project = await prisma.project.create({
    data: {
      name: 'Demo Project',
    },
  });

  console.log(`Created project: ${project.id}`);
  console.log('\nNext steps:');
  console.log('1. Upload 3+ video files via the UI');
  console.log('2. Add clips to timeline');
  console.log('3. Add speed keyframes');
  console.log('4. Add text overlay with animation');
  console.log('5. Export and download');

  await prisma.$disconnect();
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
