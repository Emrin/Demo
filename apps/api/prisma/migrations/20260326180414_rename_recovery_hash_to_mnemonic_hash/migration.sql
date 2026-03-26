/*
  Warnings:

  - You are about to drop the column `recoveryHash` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "recoveryHash",
ADD COLUMN     "mnemonicHash" TEXT NOT NULL DEFAULT '';
