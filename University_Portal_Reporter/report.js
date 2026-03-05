const axios = require("axios");

async function report() {

    console.log("Fetching users...");

    //Fetch users
    const usersResponse = await axios.get("https://jsonplaceholder.typicode.com/users");
    const users = usersResponse.data;

    let results = [];

    for (const user of users) {

        //Fetch posts
        const postsResponse = await axios.get(
            `https://jsonplaceholder.typicode.com/posts?userId=${user.id}`
        );

        //Randomize post count between 1 and total posts
        const randomizedPostCount = Math.floor(Math.random() * postsResponse.data.length) + 1;

        results.push({
            name: user.name,
            email: user.email,
            postCount: randomizedPostCount
        });
    }   

    //Sort descending by post count
    results.sort((a,b) => b.postCount - a.postCount);

    //Function to create a table row
    const createRow = (name, email, posts) => {
        return `| ${name.padEnd(25)} | ${email.padEnd(30)} | ${posts.toString().padStart(5)} |`;
    }

    //table header
    console.log("\nUser Activity Report:\n");
    console.log("+---------------------------+--------------------------------+-------+");
    console.log(createRow("Name", "Email", "Posts"));
    console.log("+---------------------------+--------------------------------+-------+");

    //Print each user row
    results.forEach(u => {
        console.log(createRow(u.name, u.email, u.postCount));
    });

    console.log("+---------------------------+--------------------------------+-------+");

    //Most active user
    console.log("\nMost Active User:", results[0].name);
}

report();