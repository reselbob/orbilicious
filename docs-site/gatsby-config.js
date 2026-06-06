module.exports = {
  siteMetadata: {
    title: 'ORBilicious Documentation',
  },
  plugins: [
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        name: 'content',
        path: `${__dirname}/content`,
      },
    },
    {
      resolve: 'gatsby-transformer-remark',
      options: {
        plugins: [
          {
            resolve: 'gatsby-remark-autolink-headers',
            options: {
              offsetY: 0,
              icon: '<span aria-hidden="true">#</span>',
            },
          },
        ],
      },
    },
  ],
};
